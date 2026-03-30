import { Checkpoint, EventBatch, ProjectionEvent } from './types';

/**
 * Abstract interface for polling events from an event store.
 * Any event store adapter (EventStoreDB, Kafka, In-Memory, etc.) must implement this.
 * 
 * This interface supports two polling modes:
 * 1. Global: Polls ALL events across all aggregate types
 * 2. Filtered: Polls events from specific aggregate types (for .join streams)
 */
export interface IEventSubscription {
  /**
   * Poll a batch of events starting from the given checkpoint.
   * 
   * @param fromCursor The checkpoint to resume from (excludes this cursor)
   * @param batchSize Maximum number of events to return
   * @returns A batch of events with cursor information
   */
  poll(fromCursor: Checkpoint, batchSize: number): Promise<EventBatch<ProjectionEvent>>;

  /**
   * Get the current latest checkpoint (for initialization).
   * Used when no checkpoint exists yet.
   */
  getLatestCheckpoint(): Promise<Checkpoint>;

  /**
   * Optional: Filter by aggregate types.
   * Returns events only from specified aggregate types.
   */
  filterByAggregateTypes?(types: string[]): IEventSubscription;
}
