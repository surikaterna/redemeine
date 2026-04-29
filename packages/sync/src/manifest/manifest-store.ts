import type { SyncManifest } from './manifest';

// ---------------------------------------------------------------------------
// Manifest store — pluggable persistence adapter
// ---------------------------------------------------------------------------

/**
 * Adapter contract for manifest persistence.
 *
 * Consumers provide an implementation backed by their storage of choice
 * (database, file system, in-memory, etc.). The framework uses this
 * interface to load and save manifests during recomputation.
 */
export interface IManifestStore {
  /** Retrieve the current manifest for a downstream node, if one exists. */
  getManifest(nodeId: string): Promise<SyncManifest | undefined>;

  /** Persist a manifest (insert or update). */
  saveManifest(manifest: SyncManifest): Promise<void>;

  /** Retrieve only the current version number for fast staleness checks. */
  getManifestVersion(nodeId: string): Promise<number | undefined>;
}
