/**
 * Core types for the projections system
 */

/**
 * Checkpoint for tracking event progress
 */
export interface Checkpoint {
  sequence: number;
  sequenceNumber?: number;
  timestamp?: string;
  timestamp_?: number;
  custom?: Record<string, unknown>;
}

/**
 * Event representing something that happened in the domain
 * Used by the ProjectionDaemon when processing events from subscriptions
 */
export interface ProjectionEvent<TPayload = unknown> {
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: TPayload;
  sequence: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Batch of events returned from subscription
 */
export interface EventBatch<TEvent extends ProjectionEvent = ProjectionEvent> {
  events: TEvent[];
  nextCursor: Checkpoint;
  hasMore?: boolean;
}

/**
 * Cursor for resuming event consumption
 */
export type Cursor = Checkpoint;
