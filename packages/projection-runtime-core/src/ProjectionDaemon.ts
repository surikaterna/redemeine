import { produce, Draft } from 'immer';
import { IProjectionStore } from './IProjectionStore';
import { IEventSubscription } from './IEventSubscription';
import { Checkpoint, ProjectionEvent } from './types';
import { ProjectionDefinition, ProjectionContext } from './createProjection';
import { IProjectionLinkStore } from './IProjectionLinkStore';

/**
 * Configuration options for the ProjectionDaemon
 */
export interface ProjectionDaemonOptions<TState> {
  /** The projection definition to run */
  projection: ProjectionDefinition<TState>;
  /** The event subscription to poll from */
  subscription: IEventSubscription;
  /** The state store for persistence */
  store: IProjectionStore<TState>;
  /** Batch size for polling (default: 100) */
  batchSize?: number;
  /** Polling interval in ms (default: 1000) */
  pollInterval?: number;
  /** Callback on each processed batch */
  onBatch?: (stats: BatchStats) => void;
  /** Link store for join routing correlation */
  linkStore: IProjectionLinkStore;
}

export interface BatchStats {
  eventsProcessed: number;
  documentsUpdated: number;
  duration: number;
}

/**
 * The Projection Daemon orchestrates the projection engine.
 *
 * Processing Pipeline:
 * 1. Poll batch of events from IEventSubscription
 * 2. For each event:
 *    - Determine TargetDocumentId (from .from aggregateId OR via ProjectionLinks for .join)
 *    - Load current state (or create via .initialState() if null)
 *    - Wrap in Immer's produce()
 *    - Execute developer's pure handler against draft
 * 3. If multiple events in batch route to SAME document:
 *    - Fold them sequentially through Immer draft
 *    - Save once at end of batch (batching/in-memory folding)
 * 4. Save `batch.nextCursor` as checkpoint (last processed event)
 */
export class ProjectionDaemon<TState = unknown> {
  private isRunning = false;
  private shouldStop = false;

  constructor(private options: ProjectionDaemonOptions<TState>) {}

  /**
   * Start the daemon's polling loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.shouldStop = false;

    while (!this.shouldStop) {
      await this.processBatch();

      if (!this.shouldStop && this.options.pollInterval) {
        await this.delay(this.options.pollInterval);
      }
    }

    this.isRunning = false;
  }

  /**
   * Stop the daemon gracefully
   */
  stop(): void {
    this.shouldStop = true;
  }

  /**
   * Process a single batch of events
   *
   * Processing approach:
   * 1. Iterate events in order
   * 2. For each event, determine if it can be processed:
   *    - .from events: always process immediately (may create subscriptions)
   *    - .join events: process only if subscription exists
   * 3. After processing .from events, re-check remaining events for subscriptions
   *    that may have been created during processing
   */
  async processBatch(): Promise<BatchStats> {
    const startTime = Date.now();
    const { projection, subscription, store, batchSize = 100, onBatch } = this.options;

    // Get cursor for this projection
    const cursor = await this.getCurrentCursor();

    // Poll events
    const batch = await subscription.poll(cursor, batchSize);

    if (batch.events.length === 0) {
      const emptyStats = { eventsProcessed: 0, documentsUpdated: 0, duration: Date.now() - startTime };
      if (onBatch) onBatch(emptyStats);
      return emptyStats;
    }

    // Track which events have been processed
    const processedEvents = new Set<string>();

    // Track documents that need to be saved
    const pendingDocuments = new Map<string, {
      docId: string;
      state: TState;
      events: ProjectionEvent[];
      cursor: Checkpoint;
    }>();

    // Process events in order - multiple passes to handle dynamic subscriptions
    let madeProgress = true;
    let passCount = 0;
    const maxPasses = batch.events.length + 1; // Prevent infinite loops

    while (madeProgress && passCount < maxPasses) {
      madeProgress = false;
      passCount++;

      for (const event of batch.events) {
        const eventKey = `${event.aggregateType}:${event.aggregateId}:${event.sequence}`;
        if (processedEvents.has(eventKey)) continue;

        const targetDocIds = await this.resolveTargetDocumentIds(event);

        if (targetDocIds.length === 0) {
          // Skip events without valid targets (join events without subscription)
          continue;
        }

        for (const targetDocId of targetDocIds) {
          // Get or create pending document
          let pending = pendingDocuments.get(targetDocId);
          if (!pending) {
            const existingState = await store.load(targetDocId);
            const state = existingState || projection.initialState(targetDocId);
            pending = {
              docId: targetDocId,
              state: state as TState,
              events: [],
              cursor: { sequence: 0 }
            };
            pendingDocuments.set(targetDocId, pending);
          }

          // Process the event (this may trigger subscriptions via context)
          this.currentDocId = targetDocId;
          const context = this.createContext();

          pending.state = produce(pending.state, (draft: Draft<TState>) => {
            const handler = this.findHandler(event);
            if (handler) {
              handler(draft, event, context);
            }
          });

          await this.persistContextSubscriptions(context);

          // Update cursor to latest event
          pending.cursor = {
            sequence: Math.max(pending.cursor.sequence, event.sequence),
            timestamp: event.timestamp
          };

          this.currentDocId = null;
        }

        processedEvents.add(eventKey);
        madeProgress = true;
      }
    }

    // Save all pending documents
    for (const pending of pendingDocuments.values()) {
      await store.save(pending.docId, pending.state, pending.cursor);
    }

    // Save checkpoint from subscription contract:
    // nextCursor is the last returned/processed event checkpoint.
    await this.saveCursor(batch.nextCursor);

    const stats = {
      eventsProcessed: processedEvents.size,
      documentsUpdated: pendingDocuments.size,
      duration: Date.now() - startTime
    };

    if (onBatch) onBatch(stats);

    return stats;
  }

  /**
   * Determine target document ID for an event
   *
   * RULES:
   * 1. If event is from .from stream: use projection.identity(event) as document ID
   * 2. If event is from .join stream: ONLY process if subscribeTo() was called
   *    for this aggregate+id; otherwise IGNORE (prevent ghost documents)
   */
  private async resolveTargetDocumentIds(event: ProjectionEvent): Promise<string[]> {
    const { projection } = this.options;

    // Check if this is a .from stream event
    if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
      const identity = projection.identity(event);
      const docIds = Array.isArray(identity) ? identity : [identity];
      return Array.from(new Set(docIds));
    }

    // Check if this is a .join stream event
    const joinStream = projection.joinStreams?.find(
      js => js.aggregate.__aggregateType === event.aggregateType
    );

    if (joinStream) {
      // .join events ONLY process if we have a subscription
      const targetDocId = await this.options.linkStore.resolveTarget(event.aggregateType, event.aggregateId);

      if (targetDocId) {
        return [targetDocId];
      }

      // No subscription - IGNORE this event (prevents ghost documents)
      return [];
    }

    // Unknown stream type - ignore
    return [];
  }

  /**
   * Create the context object passed to handlers
   */
  private createContext(): ProjectionContext {
    const subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];

    return {
      subscribeTo(aggregate, aggregateId) {
        subscriptions.push({ aggregate, aggregateId });
      },
      getSubscriptions() {
        return [...subscriptions];
      }
    };
  }

  /**
   * Find the appropriate handler for an event
   */
  private findHandler(event: ProjectionEvent): ((state: Draft<TState>, event: ProjectionEvent, ctx: ProjectionContext) => void) | null {
    const { projection } = this.options;
    const resolve = (handlers: Record<string, ((state: Draft<TState>, event: ProjectionEvent, ctx: ProjectionContext) => void)>): ((state: Draft<TState>, event: ProjectionEvent, ctx: ProjectionContext) => void) | null => {
      const candidateKeys = this.getHandlerCandidateKeys(event);
      for (const key of candidateKeys) {
        const handler = handlers[key];
        if (handler) return handler;
      }
      return null;
    };

    // Check .from stream handlers
    const fromHandlers = projection.fromStream.handlers;
    if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
      return resolve(fromHandlers);
    }

    // Check .join stream handlers
    for (const joinStream of projection.joinStreams || []) {
      if (event.aggregateType === joinStream.aggregate.__aggregateType) {
        return resolve(joinStream.handlers);
      }
    }

    return null;
  }

  private async persistContextSubscriptions(context: ProjectionContext): Promise<void> {
    const currentDocId = this.resolveCurrentDocumentId();

    for (const subscription of context.getSubscriptions()) {
      await this.options.linkStore.addLink(
        subscription.aggregate.__aggregateType,
        subscription.aggregateId,
        currentDocId
      );
    }
  }

  private getHandlerCandidateKeys(event: ProjectionEvent): string[] {
    const keys = new Set<string>();
    const eventType = event.type;
    const aggregatePrefix = `${event.aggregateType}.`;
    const hasAggregatePrefix = eventType.startsWith(aggregatePrefix);
    const hasEventSuffix = eventType.endsWith('.event');

    keys.add(eventType);

    if (hasAggregatePrefix) {
      keys.add(eventType.slice(aggregatePrefix.length));
    }

    if (hasEventSuffix) {
      const withoutEventSuffix = eventType.slice(0, -'.event'.length);
      keys.add(withoutEventSuffix);

      if (withoutEventSuffix.startsWith(aggregatePrefix)) {
        keys.add(withoutEventSuffix.slice(aggregatePrefix.length));
      }
    }

    return Array.from(keys);
  }

  /**
   * Get cursor for this projection from store
   */
  private async getCurrentCursor(): Promise<Checkpoint> {
    const { projection, store } = this.options;
    const checkpointKey = `__cursor__${projection.name}`;

    if (store.getCheckpoint) {
      const checkpoint = await store.getCheckpoint(checkpointKey);
      return checkpoint || { sequence: 0 };
    }

    return { sequence: 0 };
  }

  /**
   * Save cursor checkpoint.
   *
   * Cursor contract: checkpoint stores the last processed event sequence.
   */
  private async saveCursor(cursor: Checkpoint): Promise<void> {
    const { projection, store } = this.options;
    // Use type assertion for cursor storage - we store cursor data with empty state object
    await store.save(`__cursor__${projection.name}`, {} as TState, cursor);
  }

  /**
   * Track current document ID during processing (for subscribeTo context)
   */
  private currentDocId: string | null = null;
  private resolveCurrentDocumentId(): string {
    return this.currentDocId || '';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
