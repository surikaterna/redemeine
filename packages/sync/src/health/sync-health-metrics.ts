import type { ConnectionState } from '../upstream/connection-state';
import type { SyncLane } from '../manifest/lanes';

// ---------------------------------------------------------------------------
// Per-lane lag metrics
// ---------------------------------------------------------------------------

/**
 * Lag metrics for a single replication lane.
 *
 * Compares the local checkpoint position against the upstream head
 * to estimate how far behind the local node is.
 */
export interface LaneLagMetrics {
  /** Opaque local checkpoint position, or `undefined` if no checkpoint exists. */
  readonly localCheckpoint: string | undefined;

  /** Opaque upstream head position, or `undefined` if not available. */
  readonly upstreamHead: string | undefined;

  /**
   * Estimated lag in milliseconds, or `undefined` if it cannot be computed
   * (e.g. when either position is unknown or positions are not comparable).
   */
  readonly estimatedLag: number | undefined;
}

// ---------------------------------------------------------------------------
// Health metrics snapshot
// ---------------------------------------------------------------------------

/**
 * Point-in-time health metrics for a single sync node.
 *
 * Designed for dashboard consumption and operational alerting.
 * All fields are readonly to enforce immutability of snapshots.
 */
export interface SyncHealthMetrics {
  /** Current upstream connection state. */
  readonly connectionStatus: ConnectionState;

  /** Number of commands waiting in the outbound queue. */
  readonly commandQueueDepth: number;

  /** Number of in-flight commands (same as commandQueueDepth). */
  readonly inFlightCommandCount: number;

  /** Replication lag metrics per sync lane. */
  readonly perLaneSyncLag: Readonly<Record<SyncLane, LaneLagMetrics>>;

  /** ISO-8601 timestamp of the last successful sync per lane. */
  readonly lastSyncTimestamp: Readonly<Record<SyncLane, string | undefined>>;

  /** Identifier of the node that produced this snapshot. */
  readonly nodeId: string;

  /** ISO-8601 timestamp when this snapshot was captured. */
  readonly capturedAt: string;
}
