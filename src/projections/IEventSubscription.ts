import { Checkpoint, EventBatch } from './types';

/**
 * Interface for subscribing to and polling events from an event store
 */
export interface IEventSubscription {
  /**
   * Poll a batch of events from the cursor position
   * @param cursor The cursor to start from
   * @param batchSize Maximum number of events to return
   * @returns A batch of events and the next cursor position
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
