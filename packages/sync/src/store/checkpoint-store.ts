import type { SyncLane } from '../manifest/lanes';

// Re-export so consumers can import SyncLane from the store barrel.
export type { SyncLane } from '../manifest/lanes';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** A persisted sync position for a single replication lane. */
export interface Checkpoint {
  /** The lane this checkpoint belongs to. */
  readonly lane: SyncLane;

  /**
   * Opaque position token. The format is transport-specific
   * (e.g. cursor, sequence number, timestamp).
   */
  readonly position: string;

  /** ISO-8601 timestamp when this checkpoint was persisted. */
  readonly savedAt: string;
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/**
 * Adapter contract for persisting per-lane sync checkpoints.
 *
 * Consumers provide a concrete implementation backed by any
 * durable storage. The framework reads and writes checkpoints
 * to track downstream replication progress across restarts.
 */
export interface ICheckpointStore {
  /**
   * Retrieves the most recent checkpoint for the given lane,
   * or `undefined` if no checkpoint has been saved yet.
   *
   * @param lane — the replication lane to query.
   */
  getCheckpoint(lane: SyncLane): Promise<Checkpoint | undefined>;

  /**
   * Persists a checkpoint for the given lane, replacing any
   * previously stored value.
   *
   * @param lane       — the replication lane.
   * @param checkpoint — the checkpoint to persist.
   */
  saveCheckpoint(lane: SyncLane, checkpoint: Checkpoint): Promise<void>;
}
