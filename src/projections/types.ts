/**
 * Projection system types for resumable event processing.
 */

/**
 * Represents a cursor position for tracking event processing progress.
 * Used to resume polling from the last processed event after restarts.
 */
export interface Checkpoint {
  /** Sequence or offset number for ordering */
  sequence: number;
  /** ISO timestamp for time-based ordering (optional) */
  timestamp?: string;
}

/**
 * A batch of events returned from IEventSubscription.poll()
 */
export interface EventBatch<TEvent = unknown> {
  /** The events in this batch */
  events: TEvent[];
  /** Checkpoint to resume from for next poll (should be after last event) */
  nextCursor: Checkpoint;
  /** Indicates if there are more events available beyond this batch */
  hasMore: boolean;
}

/**
 * Standard envelope for domain events with metadata needed by projections
 */
export interface ProjectionEvent<P = unknown, T extends string = string> {
  /** Unique event identifier */
  id: string;
  /** Aggregate type name (e.g., 'invoice', 'order') */
  aggregateType: string;
  /** Aggregate instance ID */
  aggregateId: string;
  /** Event type string (e.g., 'invoice.created.event') */
  type: T;
  /** Event payload data */
  payload: P;
  /** Event sequence number within the aggregate stream */
  sequence: number;
  /** ISO timestamp when event was created */
  timestamp: string;
  /** Optional correlation/causation metadata */
  metadata?: Record<string, unknown>;
}
