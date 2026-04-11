/**
 * A point-in-time snapshot of an aggregate's state, imported from
 * upstream to accelerate local hydration.
 *
 * Snapshots are opaque blobs — the store adapter persists and retrieves
 * them without interpreting the {@link state} payload.
 */
export interface AggregateSnapshot {
  /** Aggregate stream this snapshot belongs to. */
  readonly streamId: string;

  /** Stream version at which the snapshot was captured. */
  readonly version: number;

  /** Serialized aggregate state at the snapshot version. */
  readonly state: unknown;

  /** ISO-8601 timestamp when the snapshot was captured. */
  readonly snapshotAt: string;
}
