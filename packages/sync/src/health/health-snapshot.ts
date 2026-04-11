import type { IConnectionMonitor } from '../upstream/connection-state';
import type { ICommandQueue } from '../store/command-queue';
import type { ICheckpointStore } from '../store/checkpoint-store';
import type { SyncLane } from '../manifest/lanes';
import { SYNC_LANES } from '../manifest/lanes';
import type { SyncHealthMetrics, LaneLagMetrics } from './sync-health-metrics';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies required to capture a health snapshot. */
export interface HealthSnapshotDependencies {
  /** Monitors upstream connection state. */
  readonly connectionMonitor: IConnectionMonitor;

  /** Outbound command queue. */
  readonly commandQueue: ICommandQueue;

  /** Per-lane checkpoint persistence. */
  readonly checkpointStore: ICheckpointStore;

  /** Identifier of the local node. */
  readonly nodeId: string;
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

/**
 * Gathers metrics from all dependency sources into a point-in-time
 * health snapshot.
 *
 * Some fields cannot be populated from the available dependencies
 * and are set to safe defaults (see inline TODO comments).
 */
export async function captureHealthSnapshot(
  deps: HealthSnapshotDependencies,
): Promise<SyncHealthMetrics> {
  const connectionStatus = deps.connectionMonitor.getState();
  const commandQueueDepth = await deps.commandQueue.depth();

  const perLaneSyncLag = {} as Record<SyncLane, LaneLagMetrics>;
  const lastSyncTimestamp = {} as Record<SyncLane, string | undefined>;

  for (const lane of SYNC_LANES) {
    const checkpoint = await deps.checkpointStore.getCheckpoint(lane);

    perLaneSyncLag[lane] = {
      localCheckpoint: checkpoint?.position,
      // TODO: upstreamHead requires an additional adapter to query the
      // upstream node's head position per lane. Set to undefined until
      // that adapter support is available.
      upstreamHead: undefined,
      estimatedLag: undefined,
    };

    lastSyncTimestamp[lane] = checkpoint?.savedAt;
  }

  return {
    connectionStatus,
    commandQueueDepth,
    // TODO: pendingEventCount requires an adapter that can query the
    // event store for pending event counts by stream. Set to zero
    // until that adapter support is available.
    pendingEventCount: { total: 0, byStream: {} },
    perLaneSyncLag,
    lastSyncTimestamp,
    nodeId: deps.nodeId,
    capturedAt: new Date().toISOString(),
  };
}
