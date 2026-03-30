/**
 * Core types for the projections system
 */

/**
 * Checkpoint for tracking event progress
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
 * Batch of events returned from subscription
 */
export interface EventBatch {
  events: ProjectionEvent[];
  nextCursor: Checkpoint;
}

/**
 * Cursor for resuming event consumption
 */
export type Cursor = Checkpoint;
