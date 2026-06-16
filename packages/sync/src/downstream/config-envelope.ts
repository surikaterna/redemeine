// ---------------------------------------------------------------------------
// Configuration Lane — Envelope Types
// ---------------------------------------------------------------------------

/**
 * Full configuration state for a namespace at a specific version.
 * Used for initial delivery or periodic re-snapshots.
 */
export interface ConfigSnapshot {
  readonly type: 'snapshot';
  readonly namespace: string;
  readonly config: unknown;
  readonly version: number;
  /** ISO-8601 timestamp when the snapshot was captured. */
  readonly snapshotAt: string;
}

/**
 * Incremental update to a configuration namespace.
 * Patches are applied in order to advance the config
 * from {@link fromVersion} to {@link toVersion}.
 */
export interface ConfigDelta {
  readonly type: 'delta';
  readonly namespace: string;
  /** Ordered patch operations (format is consumer-defined). */
  readonly patches: ReadonlyArray<unknown>;
  readonly fromVersion: number;
  readonly toVersion: number;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all envelope types delivered on the
 * configuration lane. Consumers switch on {@link ConfigEnvelope.type type}
 * to handle each variant.
 */
export type ConfigEnvelope = ConfigSnapshot | ConfigDelta;
