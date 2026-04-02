import { Checkpoint, EventBatch } from './types';

/**
 * Interface for subscribing to and polling events from an event store
 */
export interface IEventSubscription {
  /**
   * Poll a batch of events from the cursor position.
   *
   * Cursor contract:
   * - `cursor` is exclusive: return events with `sequence > cursor.sequence`.
   * - `nextCursor` in the returned batch must represent the last returned event
   *   checkpoint (or remain at `cursor` when no events are returned).
   *
   * @param cursor The exclusive cursor checkpoint to read after
   * @param batchSize Maximum number of events to return
   * @returns A batch of events and the last-returned checkpoint
   */
  poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch>;
  
  /**
   * Subscribe to specific aggregate IDs for join streams
   * @param aggregateType The type of aggregate to subscribe to
   * @param aggregateIds The specific aggregate IDs to subscribe to
   */
  subscribe?(aggregateType: string, aggregateIds: string[]): Promise<void>;
  
  /**
   * Unsubscribe from specific aggregate IDs
   * @param aggregateType The type of aggregate to unsubscribe from
   * @param aggregateIds The specific aggregate IDs to unsubscribe from
   */
  unsubscribe?(aggregateType: string, aggregateIds: string[]): Promise<void>;
}
