// ---------------------------------------------------------------------------
// Projection + Master Data Lane — Envelope Types
// ---------------------------------------------------------------------------

/**
 * Full state of a projection document at a specific version.
 * Used for initial delivery or periodic re-snapshots.
 */
export interface ProjectionSnapshot {
  readonly type: 'snapshot';
  readonly projectionName: string;
  readonly documentId: string;
  readonly state: unknown;
  readonly version: number;
  /** ISO-8601 timestamp when the snapshot was captured. */
  readonly snapshotAt: string;
}

/**
 * Incremental update to a projection document.
 * Patches are applied in order to advance the document
 * from {@link fromVersion} to {@link toVersion}.
 */
export interface ProjectionDelta {
  readonly type: 'delta';
  readonly projectionName: string;
  readonly documentId: string;
  /** Ordered patch operations (format is consumer-defined). */
  readonly patches: ReadonlyArray<unknown>;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * A projection document has been removed from the feed.
 * Downstream should prune local copies.
 */
export interface ProjectionRemoved {
  readonly type: 'removed';
  readonly projectionName: string;
  readonly documentId: string;
  /** ISO-8601 timestamp when the document was removed from the feed. */
  readonly removedAt: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all envelope types delivered on the
 * projections and master data lanes. Both lanes use the same
 * envelope structure — the semantic distinction is in the lane
 * identifier, not the envelope shape.
 *
 * Consumers switch on {@link ProjectionEnvelope.type type}
 * to handle each variant.
 */
export type ProjectionEnvelope =
  | ProjectionSnapshot
  | ProjectionDelta
  | ProjectionRemoved;
