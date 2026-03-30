/**
 * Represents a cursor/checkpoint position for resumable event processing.
 * The checkpoint captures the event sequence position for reliable recovery.
 */
export interface Checkpoint {
  /** The sequence ID or offset of the last processed event */
  sequence: number;
  /** Optional timestamp for debugging and ordering purposes */
  timestamp?: number;
  /** Optional metadata for additional checkpoint context */
  metadata?: Record<string, unknown>;
}
