import { IEventSubscription } from './IEventSubscription';
import { Checkpoint, EventBatch, ProjectionEvent } from './types';

/**
 * Minimal EventStore reader contract for catch-up polling.
 *
 * Implementations should return events after the provided sequence,
 * but adapter still enforces exclusive cursor filtering and ordering.
 */
export interface EventStoreCatchUpReader {
  readAfter(sequence: number, limit: number): Promise<readonly ProjectionEvent[]>;
}

/**
 * Adapts an EventStore catch-up reader to runtime-core subscription contract.
 *
 * Cursor semantics are exclusive:
 * - input cursor points at last processed sequence
 * - returned events are strictly `sequence > cursor.sequence`
 * - nextCursor points at last returned event (or remains unchanged on empty batch)
 */
export class EventStoreCatchUpSubscription implements IEventSubscription {
  constructor(private readonly reader: EventStoreCatchUpReader) {}

  async poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch> {
    const raw = await this.reader.readAfter(cursor.sequence, batchSize);

    const events = raw
      .filter((event) => event.sequence > cursor.sequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, batchSize);

    if (events.length === 0) {
      return { events: [], nextCursor: cursor };
    }

    const last = events[events.length - 1];
    return {
      events,
      nextCursor: {
        sequence: last.sequence,
        timestamp: last.timestamp
      }
    };
  }
}
