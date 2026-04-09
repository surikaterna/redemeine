/**
 * Core types for the projections system
 */

/**
 * Checkpoint for tracking event progress.
 *
 * Cursor semantics:
 * - `poll(fromCursor, ...)` is exclusive: return events with `sequence > fromCursor.sequence`.
 * - A checkpoint points at the last returned/processed event (not last+1).
 */
export interface Checkpoint {
  sequence: number;
  timestamp?: string;
}

/**
 * Event representing something that happened in the domain
 */
export interface ProjectionEvent {
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Batch of events returned from subscription.
 *
 * `nextCursor` is the checkpoint for the last event included in `events`.
 * If `events` is empty, `nextCursor` should remain at the input cursor.
 */
export interface EventBatch {
  events: ProjectionEvent[];
  nextCursor: Checkpoint;
}

/**
 * Cursor for resuming event consumption
 */
export type Cursor = Checkpoint;
