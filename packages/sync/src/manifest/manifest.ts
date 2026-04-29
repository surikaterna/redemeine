import type { SyncLane } from './lanes';
import type { LaneSelector } from './selectors';

// ---------------------------------------------------------------------------
// SyncManifest — the upstream-internal control document
// ---------------------------------------------------------------------------

/**
 * A sync manifest describes the complete set of data selectors active for a
 * given downstream node. It is upstream-internal — downstream never sees it.
 *
 * The manifest is a live reactive projection: continuously recomputed from
 * domain state, versioned monotonically, and content-hashed for fast equality.
 */
export interface SyncManifest {
  /** Target downstream node identifier. */
  readonly nodeId: string;

  /** Monotonically increasing version — every recomputation increments this. */
  readonly version: number;

  /** Content hash for fast equality check (e.g. SHA-256 of canonical selector set). */
  readonly etag: string;

  /** All active selectors across all four lanes. */
  readonly selectors: ReadonlyArray<LaneSelector>;

  /** ISO-8601 timestamp of the last manifest update. */
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// ManifestByLane — convenience grouping
// ---------------------------------------------------------------------------

/**
 * Helper type that groups selectors by their lane for convenient access.
 * Each lane key holds only the selectors belonging to that lane.
 */
export type ManifestByLane = {
  readonly [L in SyncLane]: ReadonlyArray<Extract<LaneSelector, { lane: L }>>;
};

/**
 * Groups the selectors from a manifest by lane.
 * Pure function — returns a new `ManifestByLane` without mutating the input.
 */
export function groupSelectorsByLane(
  selectors: ReadonlyArray<LaneSelector>,
): ManifestByLane {
  const events: Array<Extract<LaneSelector, { lane: 'events' }>> = [];
  const projections: Array<Extract<LaneSelector, { lane: 'projections' }>> = [];
  const masterData: Array<Extract<LaneSelector, { lane: 'masterData' }>> = [];
  const configuration: Array<Extract<LaneSelector, { lane: 'configuration' }>> = [];

  for (const sel of selectors) {
    switch (sel.lane) {
      case 'events':
        events.push(sel);
        break;
      case 'projections':
        projections.push(sel);
        break;
      case 'masterData':
        masterData.push(sel);
        break;
      case 'configuration':
        configuration.push(sel);
        break;
    }
  }

  return { events, projections, masterData, configuration };
}
