import { produce, Draft } from 'immer';
import { IProjectionStore } from './IProjectionStore';
import { IEventSubscription } from './IEventSubscription';
import { Checkpoint, EventBatch, ProjectionEvent, ProjectionWarning } from './types';
import { ProjectionDefinition, ProjectionContext } from './createProjection';
import { encodeProjectionDedupeKey } from './contracts';

type RuntimeMode = 'catching_up' | 'ready_to_cutover' | 'live';

interface CutoverSubscriptions {
  catchUp: IEventSubscription;
  live: IEventSubscription;
}

interface RuntimeModeMetadata {
  mode: RuntimeMode;
  updatedAt: string;
}

export interface ProjectionDaemonOptions<TState> {
  projection: ProjectionDefinition<TState>;
  subscription?: IEventSubscription;
  subscriptions?: CutoverSubscriptions;
  store: IProjectionStore<TState>;
  batchSize?: number;
  pollInterval?: number;
  onBatch?: (stats: BatchStats) => void;
  onWarning?: (warning: ProjectionWarning) => void;
}

export interface BatchStats {
  eventsProcessed: number;
  documentsUpdated: number;
  duration: number;
  diagnostics: {
    cursorStart: Checkpoint;
    cursorEnd: Checkpoint;
    dedupeSuppressed: number;
    warnings: number;
  };
}

interface RuntimeProjectionContext extends ProjectionContext {
  getSubscriptions(): Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
  getUnsubscriptions(): Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
}

class SubscriptionOrchestrator<TState = unknown> {
  private readonly cursorKey: string;
  private readonly modeKey: string;

  constructor(
    private readonly projectionName: string,
    private readonly store: IProjectionStore<TState>,
    private readonly singleSubscription: IEventSubscription | null,
    private readonly cutoverSubscriptions: CutoverSubscriptions | null
  ) {
    this.cursorKey = `__cursor__${projectionName}`;
    this.modeKey = `__checkpoint__${projectionName}__runtime_mode`;
  }

  async poll(cursor: Checkpoint, batchSize: number): Promise<{ batch: EventBatch | null; mode: RuntimeMode }> {
    if (this.singleSubscription) {
      return {
        batch: await this.singleSubscription.poll(cursor, batchSize),
        mode: 'live'
      };
    }

    if (!this.cutoverSubscriptions) {
      throw new Error('Projection daemon requires either options.subscription or options.subscriptions');
    }

    const mode = await this.loadRuntimeMode();

    if (mode === 'catching_up') {
      const catchUpBatch = await this.cutoverSubscriptions.catchUp.poll(cursor, batchSize);

      if (catchUpBatch.events.length > 0) {
        return {
          batch: catchUpBatch,
          mode
        };
      }

      // Durable intermediate state to make cutover restart-safe.
      await this.persistRuntimeMode('ready_to_cutover', cursor);

      return {
        batch: null,
        mode: 'ready_to_cutover'
      };
    }

    if (mode === 'ready_to_cutover') {
      await this.persistRuntimeMode('live', cursor);

      return {
        batch: null,
        mode: 'live'
      };
    }

    return {
      batch: await this.cutoverSubscriptions.live.poll(cursor, batchSize),
      mode
    };
  }

  private async loadRuntimeMode(): Promise<RuntimeMode> {
    const metadata = await this.store.load(this.modeKey);
    const candidate = (metadata as RuntimeModeMetadata | null)?.mode;

    if (candidate === 'catching_up' || candidate === 'ready_to_cutover' || candidate === 'live') {
      return candidate;
    }

    return 'catching_up';
  }

  private async persistRuntimeMode(mode: RuntimeMode, checkpoint: Checkpoint): Promise<void> {
    await this.store.commitAtomic({
      documents: [{
        documentId: this.modeKey,
        state: {
          mode,
          updatedAt: new Date().toISOString()
        } as TState,
        checkpoint
      }],
      links: [],
      cursorKey: this.cursorKey,
      cursor: checkpoint,
      dedupe: { upserts: [] }
    });
  }
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
  private readonly orchestrator: SubscriptionOrchestrator<TState>;

  constructor(private options: ProjectionDaemonOptions<TState>) {
    if (options.subscription && options.subscriptions) {
      throw new Error('Projection daemon options are mutually exclusive: use either subscription or subscriptions');
    }

    this.orchestrator = new SubscriptionOrchestrator<TState>(
      options.projection.name,
      options.store,
      options.subscription ?? null,
      options.subscriptions ?? null
    );
  }

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
    const { projection, store, batchSize = 100, onBatch, onWarning } = this.options;

    // Get cursor for this projection
    const cursor = await this.getCurrentCursor();

    // Poll events through subscription orchestration.
    const orchestrated = await this.orchestrator.poll(cursor, batchSize);
    const batch = orchestrated.batch;

    if (!batch || batch.events.length === 0) {
      const cursorEnd = batch?.nextCursor ?? cursor;
      const emptyStats = {
        eventsProcessed: 0,
        documentsUpdated: 0,
        duration: Date.now() - startTime,
        diagnostics: {
          cursorStart: cursor,
          cursorEnd,
          dedupeSuppressed: 0,
          warnings: 0
        }
      };
      if (onBatch) onBatch(emptyStats);
      return emptyStats;
    }

    // Track which events have been processed
    const processedEvents = new Set<string>();
    let dedupeSuppressed = 0;

    // Track documents that need to be saved
    const pendingDocuments = new Map<string, {
      docId: string;
      state: TState;
      cursor: Checkpoint;
    }>();

    const pendingLinkAdds = new Map<string, { aggregateType: string; aggregateId: string; targetDocId: string }>();
    const pendingLinkRemoves = new Map<string, { aggregateType: string; aggregateId: string; targetDocId: string }>();
    const pendingDedupe = new Map<string, Checkpoint>();
    const unresolvedWarnings = new Map<string, ProjectionWarning>();

    // Process events in order - multiple passes to handle dynamic subscriptions
    let madeProgress = true;
    let passCount = 0;
    const maxPasses = batch.events.length + 1; // Prevent infinite loops

    while (madeProgress && passCount < maxPasses) {
      madeProgress = false;
      passCount++;

      for (const event of batch.events) {
        const eventKey = encodeProjectionDedupeKey({
          projectionName: projection.name,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          sequence: event.sequence
        });
        if (processedEvents.has(eventKey)) continue;

        const persistedCheckpoint = await store.getDedupeCheckpoint(eventKey);
        if (persistedCheckpoint) {
          dedupeSuppressed += 1;
          processedEvents.add(eventKey);
          madeProgress = true;
          continue;
        }

        const targetResolution = await this.resolveTargetDocumentIds(event, pendingLinkAdds, pendingLinkRemoves);
        const targetDocIds = targetResolution.targetDocIds;

        if (targetDocIds.length === 0) {
          if (targetResolution.warning) {
            unresolvedWarnings.set(eventKey, targetResolution.warning);
          }
          // Skip events without valid targets (join events without subscription)
          continue;
        }

        unresolvedWarnings.delete(eventKey);

        for (const targetDocId of targetDocIds) {
          // Get or create pending document
          let pending = pendingDocuments.get(targetDocId);
          if (!pending) {
            const existingState = await store.load(targetDocId);
            const state = existingState || projection.initialState(targetDocId);
            pending = {
              docId: targetDocId,
              state: state as TState,
              cursor: { sequence: 0 }
            };
            pendingDocuments.set(targetDocId, pending);
          }

          // Process the event (this may trigger subscriptions via context)
          const context = this.createContext();

          pending.state = produce(pending.state, (draft: Draft<TState>) => {
            const handler = this.findHandler(event);
            if (handler) {
              handler(draft, event, context);
            }
            if (projection.hooks?.afterEach) {
              projection.hooks.afterEach(draft as TState, event);
            }
          });

          for (const unsubscription of context.getUnsubscriptions()) {
            const linkKey = `${unsubscription.aggregate.aggregateType}:${unsubscription.aggregateId}`;
            pendingLinkAdds.delete(linkKey);

            pendingLinkRemoves.set(linkKey, {
              aggregateType: unsubscription.aggregate.aggregateType,
              aggregateId: unsubscription.aggregateId,
              targetDocId
            });
          }

          for (const subscription of context.getSubscriptions()) {
            const linkKey = `${subscription.aggregate.aggregateType}:${subscription.aggregateId}`;
            const removed = pendingLinkRemoves.get(linkKey);

            if (removed) {
              pendingLinkAdds.set(linkKey, {
                aggregateType: subscription.aggregate.aggregateType,
                aggregateId: subscription.aggregateId,
                targetDocId
              });
              continue;
            }

            const pendingAdd = pendingLinkAdds.get(linkKey);
            if (pendingAdd) {
              if (pendingAdd.targetDocId !== targetDocId) {
                pendingLinkRemoves.set(linkKey, {
                  aggregateType: pendingAdd.aggregateType,
                  aggregateId: pendingAdd.aggregateId,
                  targetDocId: pendingAdd.targetDocId
                });

                pendingLinkAdds.set(linkKey, {
                  aggregateType: subscription.aggregate.aggregateType,
                  aggregateId: subscription.aggregateId,
                  targetDocId
                });
              }

              continue;
            }

            const existingTarget = await this.options.store.resolveTarget(
              subscription.aggregate.aggregateType,
              subscription.aggregateId
            );

            if (existingTarget && existingTarget !== targetDocId) {
              pendingLinkRemoves.set(linkKey, {
                aggregateType: subscription.aggregate.aggregateType,
                aggregateId: subscription.aggregateId,
                targetDocId: existingTarget
              });

              pendingLinkAdds.set(linkKey, {
                aggregateType: subscription.aggregate.aggregateType,
                aggregateId: subscription.aggregateId,
                targetDocId
              });
              continue;
            }

            if (!existingTarget) {
              pendingLinkAdds.set(linkKey, {
                aggregateType: subscription.aggregate.aggregateType,
                aggregateId: subscription.aggregateId,
                targetDocId
              });
            }
          }

          // Update cursor to latest event
          pending.cursor = {
            sequence: Math.max(pending.cursor.sequence, event.sequence),
            timestamp: event.timestamp
          };
        }

        processedEvents.add(eventKey);
        pendingDedupe.set(eventKey, {
          sequence: event.sequence,
          timestamp: event.timestamp
        });
        madeProgress = true;
      }
    }

    if (onWarning) {
      for (const warning of unresolvedWarnings.values()) {
        onWarning(warning);
      }
    }

    // Single required production write path: atomic commit for docs + links + cursor.
    await store.commitAtomic({
      documents: Array.from(pendingDocuments.values()).map((pending) => ({
        documentId: pending.docId,
        state: pending.state,
        checkpoint: pending.cursor
      })),
      links: [
        ...Array.from(pendingLinkRemoves.values()).map((link) => ({
          op: 'remove' as const,
          aggregateType: link.aggregateType,
          aggregateId: link.aggregateId,
          targetDocId: link.targetDocId
        })),
        ...Array.from(pendingLinkAdds.values()).map((link) => ({
          op: 'add' as const,
          aggregateType: link.aggregateType,
          aggregateId: link.aggregateId,
          targetDocId: link.targetDocId
        }))
      ],
      cursorKey: `__cursor__${projection.name}`,
      // Cursor contract: nextCursor is the last returned/processed event checkpoint.
      cursor: batch.nextCursor,
      dedupe: {
        upserts: Array.from(pendingDedupe.entries()).map(([key, checkpoint]) => ({
          key,
          checkpoint
        }))
      }
    });

    const stats = {
      eventsProcessed: processedEvents.size,
      documentsUpdated: pendingDocuments.size,
      duration: Date.now() - startTime,
      diagnostics: {
        cursorStart: cursor,
        cursorEnd: batch.nextCursor,
        dedupeSuppressed,
        warnings: unresolvedWarnings.size
      }
    };

    if (onBatch) onBatch(stats);

    return stats;
  }

  /**
   * Determine target document IDs for an event and warning diagnostics.
   *
   * RULES:
   * 1. If event is from .from stream: use projection.identity(event) as document ID
   * 2. If event is from .join stream: ONLY process if subscribeTo() was called
   *    for this aggregate+id; otherwise IGNORE (prevent ghost documents)
   */
  private async resolveTargetDocumentIds(
    event: ProjectionEvent,
    pendingLinkAdds: Map<string, { aggregateType: string; aggregateId: string; targetDocId: string }>,
    pendingLinkRemoves: Map<string, { aggregateType: string; aggregateId: string; targetDocId: string }>
  ): Promise<{ targetDocIds: string[]; warning?: ProjectionWarning }> {
    const { projection } = this.options;

    // Check if this is a .from stream event
    if (event.aggregateType === projection.fromStream.aggregate.aggregateType) {
      const identity = projection.identity(event);
      const docIds = Array.isArray(identity) ? identity : [identity];
      return { targetDocIds: Array.from(new Set(docIds)) };
    }

    // Check if this is a .join stream event
    const joinStream = projection.joinStreams?.find(
      js => js.aggregate.aggregateType === event.aggregateType
    );

    if (joinStream) {
      // .join events ONLY process if we have a subscription
      const linkKey = `${event.aggregateType}:${event.aggregateId}`;
      const pendingLink = pendingLinkAdds.get(linkKey);
      const pendingRemoved = pendingLinkRemoves.get(linkKey);

      if (pendingRemoved && !pendingLink) {
        return {
          targetDocIds: [],
          warning: {
            code: 'missing_target_removal',
            projectionName: projection.name,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            eventType: event.type,
            sequence: event.sequence,
            targetDocId: pendingRemoved.targetDocId
          }
        };
      }

      const targetDocId = pendingLink?.targetDocId
        ?? await this.options.store.resolveTarget(event.aggregateType, event.aggregateId);

      if (targetDocId) {
        return { targetDocIds: [targetDocId] };
      }

      // No reverse target/subscription - warn and skip
      return {
        targetDocIds: [],
        warning: {
          code: 'missing_reverse_target',
          projectionName: projection.name,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.type,
          sequence: event.sequence
        }
      };
    }

    // Unknown stream type - ignore
    return { targetDocIds: [] };
  }

  /**
   * Create the context object passed to handlers
   */
  private createContext(): RuntimeProjectionContext {
    const subscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }> = [];
    const unsubscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }> = [];

    return {
      subscribeTo(aggregate, aggregateId) {
        subscriptions.push({ aggregate, aggregateId });
      },
      unsubscribeFrom(aggregate, aggregateId) {
        unsubscriptions.push({ aggregate, aggregateId });
      },
      getSubscriptions() {
        const remaining = new Map<string, { aggregate: { aggregateType: string }; aggregateId: string }>();

        for (const subscription of subscriptions) {
          remaining.set(`${subscription.aggregate.aggregateType}:${subscription.aggregateId}`, subscription);
        }

        for (const unsubscription of unsubscriptions) {
          remaining.delete(`${unsubscription.aggregate.aggregateType}:${unsubscription.aggregateId}`);
        }

        return Array.from(remaining.values());
      },
      getUnsubscriptions() {
        return [...unsubscriptions];
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
    if (event.aggregateType === projection.fromStream.aggregate.aggregateType) {
      return resolve(fromHandlers);
    }

    // Check .join stream handlers
    for (const joinStream of projection.joinStreams || []) {
      if (event.aggregateType === joinStream.aggregate.aggregateType) {
        return resolve(joinStream.handlers);
      }
    }

    return null;
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

  private delay(ms: number): Promise<void> {
    const schedule = (globalThis as { setTimeout?: (handler: () => void, timeout?: number) => unknown }).setTimeout;
    if (!schedule) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      schedule(() => resolve(), ms);
    });
  }
}
