import type { LaneSelector } from './selectors';
import { selectorIdentityKey } from './selectors';
import type { SyncManifest } from './manifest';

// ---------------------------------------------------------------------------
// ManifestDelta — what changed between two manifest versions
// ---------------------------------------------------------------------------

/**
 * Describes the difference between two consecutive manifest versions.
 * Used to drive lifecycle signals and incremental downstream updates.
 */
export interface ManifestDelta {
  /** Target downstream node identifier. */
  readonly nodeId: string;

  /** Previous manifest version (before the change). */
  readonly fromVersion: number;

  /** New manifest version (after the change). */
  readonly toVersion: number;

  /** Selectors that were added (present in current but not in previous). */
  readonly added: ReadonlyArray<LaneSelector>;

  /** Selectors that were removed (present in previous but not in current). */
  readonly removed: ReadonlyArray<LaneSelector>;

  /** Selectors whose identity key stayed but whose filter changed. */
  readonly changed: ReadonlyArray<LaneSelector>;

  /** ISO-8601 timestamp when this delta was computed. */
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Delta computation — pure function
// ---------------------------------------------------------------------------

/** Serialise a selector's filter to a stable string for equality comparison. */
function filterFingerprint(selector: LaneSelector): string {
  if (selector.lane === 'configuration') {
    // Configuration selectors have no filter
    return '';
  }
  if (!selector.filter) {
    return '';
  }
  return JSON.stringify({
    expression: selector.filter.expression,
    params: selector.filter.params ?? null,
  });
}

/**
 * Computes the delta between a previous and current manifest for the same node.
 *
 * Selectors are compared by their identity key (lane + aggregateType/projectionName/namespace).
 * - **added**: identity key exists in `current` but not in `previous`
 * - **removed**: identity key exists in `previous` but not in `current`
 * - **changed**: identity key exists in both but filter differs
 *
 * Pure function — no side effects.
 */
export function computeManifestDelta(
  previous: SyncManifest,
  current: SyncManifest,
): ManifestDelta {
  const prevMap = new Map<string, LaneSelector>();
  for (const sel of previous.selectors) {
    prevMap.set(selectorIdentityKey(sel), sel);
  }

  const currMap = new Map<string, LaneSelector>();
  for (const sel of current.selectors) {
    currMap.set(selectorIdentityKey(sel), sel);
  }

  const added: Array<LaneSelector> = [];
  const removed: Array<LaneSelector> = [];
  const changed: Array<LaneSelector> = [];

  // Detect added and changed
  for (const [key, currSel] of currMap) {
    const prevSel = prevMap.get(key);
    if (!prevSel) {
      added.push(currSel);
    } else if (filterFingerprint(prevSel) !== filterFingerprint(currSel)) {
      changed.push(currSel);
    }
  }

  // Detect removed
  for (const [key, prevSel] of prevMap) {
    if (!currMap.has(key)) {
      removed.push(prevSel);
    }
  }

  return {
    nodeId: current.nodeId,
    fromVersion: previous.version,
    toVersion: current.version,
    added,
    removed,
    changed,
    computedAt: new Date().toISOString(),
  };
}
