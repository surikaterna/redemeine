import { produce, Draft } from 'immer';
import { IProjectionStore } from './IProjectionStore';
import { IEventSubscription } from './IEventSubscription';
import { Checkpoint, ProjectionEvent } from './types';
import { ProjectionDefinition, ProjectionContext } from './createProjection';

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
 * 4. Save checkpoint
 */
export class ProjectionDaemon<TState = unknown> {
  private isRunning = false;
  private shouldStop = false;
  private subscriptions: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }> = [];
  
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
    
    // Group events by target document ID for batching
    const eventsByDoc = this.groupEventsByTarget(batch.events);
    
    // Process each document's events
    for (const [docId, events] of eventsByDoc) {
      await this.processDocumentEvents(docId, events);
    }
    
    // Save checkpoint
    await this.saveCursor(batch.nextCursor);
    
    const stats = {
      eventsProcessed: batch.events.length,
      documentsUpdated: eventsByDoc.size,
      duration: Date.now() - startTime
    };
    
    if (onBatch) onBatch(stats);
    
    return stats;
  }
  
  /**
   * Determine target document ID for an event
   * 
   * RULES:
   * 1. If event is from .from stream: use aggregateId as document ID
   * 2. If event is from .join stream: ONLY process if subscribeTo() was called
   *    for this aggregate+id; otherwise IGNORE (prevent ghost documents)
   */
  private resolveTargetDocumentId(event: ProjectionEvent): string | null {
    const { projection } = this.options;
    
    // Check if this is a .from stream event
    if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
      return event.aggregateId; // Primary owner dictates document ID
    }
    
    // Check if this is a .join stream event
    const joinStream = projection.joinStreams?.find(
      js => js.aggregate.__aggregateType === event.aggregateType
    );
    
    if (joinStream) {
      // .join events ONLY process if we have a subscription
      const subscription = this.subscriptions.find(
        s => s.aggregateType === event.aggregateType && s.aggregateId === event.aggregateId
      );
      
      if (subscription) {
        return subscription.targetDocId;
      }
      
      // No subscription - IGNORE this event (prevents ghost documents)
      return null;
    }
    
    // Unknown stream type - ignore
    return null;
  }
  
  /**
   * Create the context object passed to handlers
   */
  private createContext(): ProjectionContext {
    const self = this;
    const subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];
    
    return {
      subscribeTo(aggregate, aggregateId) {
        const currentDocId = self.resolveCurrentDocumentId();
        subscriptions.push({ aggregate, aggregateId });
        self.subscriptions.push({
          aggregateType: aggregate.__aggregateType,
          aggregateId,
          targetDocId: currentDocId
        });
      },
      getSubscriptions() {
        return [...subscriptions];
      }
    };
  }
  
  /**
   * Process events for a single document
   * Applies Immer produce and executes handlers
   */
  private async processDocumentEvents(docId: string, events: ProjectionEvent[]): Promise<void> {
    const { projection, store } = this.options;
    
    // Set current document ID for subscribeTo context
    this.currentDocId = docId;
    
    // Load current state or create via initialState()
    let state: TState = await store.load(docId);
    
    if (state === null) {
      state = projection.initialState(docId) as TState;
    }
    
    // Create context with current document ID
    const context = this.createContext();
    
    // Apply all events to this document using Immer
    const nextState = produce(
      state,
      (draft: Draft<TState>) => {
        for (const event of events) {
          const handler = this.findHandler(event);
          if (handler) {
            handler(draft, event, context);
          }
        }
      }
    );
    
    // Get cursor (use last event's sequence)
    const cursor: Checkpoint = {
      sequence: events[events.length - 1].sequence,
      timestamp: events[events.length - 1].timestamp
    };
    
    // Save atomically
    await store.save(docId, nextState, cursor);
    
    // Clear current document ID
    this.currentDocId = null;
  }
  
  /**
   * Find the appropriate handler for an event
   */
  private findHandler(event: ProjectionEvent): ((state: Draft<TState>, event: ProjectionEvent, ctx: ProjectionContext) => void) | null {
    const { projection } = this.options;
    
    // Check .from stream handlers
    const fromHandlers = projection.fromStream.handlers;
    if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
      const handler = fromHandlers[event.type];
      if (handler) return handler;
      // Try with base event name (without aggregate prefix)
      const baseName = event.type.split('.').slice(-2)[0];
      return fromHandlers[baseName] || null;
    }
    
    // Check .join stream handlers
    for (const joinStream of projection.joinStreams || []) {
      if (event.aggregateType === joinStream.aggregate.__aggregateType) {
        const handler = joinStream.handlers[event.type];
        if (handler) return handler;
        const baseName = event.type.split('.').slice(-2)[0];
        return joinStream.handlers[baseName] || null;
      }
    }
    
    return null;
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
   * Save cursor checkpoint
   */
  private async saveCursor(cursor: Checkpoint): Promise<void> {
    const { projection, store } = this.options;
    // Use type assertion for cursor storage - we store cursor data with empty state object
    await store.save(`__cursor__${projection.name}`, {} as TState, cursor);
  }
  
  /**
   * Group events by their target document ID
   */
  private groupEventsByTarget(events: ProjectionEvent[]): Map<string, ProjectionEvent[]> {
    const groups = new Map<string, ProjectionEvent[]>();
    
    for (const event of events) {
      const targetId = this.resolveTargetDocumentId(event);
      if (targetId === null) continue; // Skip events without valid targets
      
      const existing = groups.get(targetId) || [];
      existing.push(event);
      groups.set(targetId, existing);
    }
    
    return groups;
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
