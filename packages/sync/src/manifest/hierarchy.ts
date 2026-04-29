import type { LaneSelector } from './selectors';
import type { SyncManifest } from './manifest';

// ---------------------------------------------------------------------------
// Hierarchical manifest derivation
// ---------------------------------------------------------------------------

/**
 * Derives a child manifest from a parent manifest by filtering selectors.
 *
 * In relay topologies a relay node holds its own manifest, then derives
 * sub-manifests for each of its child nodes using a consumer-provided
 * subset filter predicate.
 *
 * The child manifest receives:
 * - A new `nodeId` for the child
 * - Version incremented from the parent's version
 * - Only the selectors for which `subsetFilter` returns `true`
 * - An `etag` derived from the filtered selector set
 * - A fresh `updatedAt` timestamp
 *
 * Pure function — no side effects.
 */
export function deriveChildManifest(
  parent: SyncManifest,
  childNodeId: string,
  subsetFilter: (selector: LaneSelector) => boolean,
): SyncManifest {
  const filteredSelectors = parent.selectors.filter(subsetFilter);

  return {
    nodeId: childNodeId,
    version: parent.version + 1,
    etag: computeEtag(filteredSelectors),
    selectors: filteredSelectors,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Compute a simple content hash for a set of selectors.
 * Uses a deterministic JSON serialisation so identical selector sets
 * always produce the same etag.
 */
function computeEtag(selectors: ReadonlyArray<LaneSelector>): string {
  const canonical = JSON.stringify(selectors);
  // Simple FNV-1a-inspired hash — sufficient for equality checks.
  // In production this would be replaced by a proper hash (SHA-256, etc.).
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
