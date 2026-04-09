import type { Checkpoint } from '../types';

export type ProjectionHydrationMode =
  | 'replay_all'
  | 'snapshot_only'
  | 'snapshot_plus_tail';

export type ProjectionHydrationStatus =
  | 'hydrating'
  | 'ready'
  | 'rebuilding'
  | 'failed';

export interface ProjectionHydrationFailure {
  at: string;
  reason: string;
  retryable?: boolean;
}

/**
 * Minimal metadata envelope persisted on read-model documents as `_projection`.
 *
 * Intentionally excludes `projectionName` because that information is redundant
 * when the document is stored within a projection-scoped collection/table.
 * Adapters may extend using `adapter` for implementation-specific details.
 */
export interface ProjectionMetadataEnvelope {
  status: ProjectionHydrationStatus;
  generation: number;
  watermark?: Checkpoint;
  updatedAt: string;
  hydratedAt?: string;
  rebuildingAt?: string;
  failed?: ProjectionHydrationFailure;
  adapter?: Readonly<Record<string, unknown>>;
}

/**
 * Optional adapter hints controlling how hydration should source events.
 */
export interface ProjectionHydrationHint {
  mode: ProjectionHydrationMode;
  snapshotWatermark?: Checkpoint;
  asOf?: string;
  adapter?: Readonly<Record<string, unknown>>;
}
