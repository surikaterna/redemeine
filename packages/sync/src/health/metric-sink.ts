import type { ConnectionState } from '../upstream/connection-state';
import type { SyncLane } from '../manifest/lanes';
import type { SyncHealthMetrics } from './sync-health-metrics';

// ---------------------------------------------------------------------------
// Alert types — discriminated union
// ---------------------------------------------------------------------------

/** Alert raised when the upstream connection state changes. */
export interface ConnectionChangedAlert {
  readonly type: 'connection_changed';
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly timestamp: string;
}

/** Alert raised when the command queue depth exceeds a threshold. */
export interface QueueDepthThresholdAlert {
  readonly type: 'queue_depth_threshold';
  readonly depth: number;
  readonly threshold: number;
  readonly timestamp: string;
}

/** Alert raised when per-lane sync lag exceeds a threshold. */
export interface SyncLagThresholdAlert {
  readonly type: 'sync_lag_threshold';
  readonly lane: SyncLane;
  readonly lag: number;
  readonly threshold: number;
  readonly timestamp: string;
}

/**
 * Discriminated union of all sync alerts.
 *
 * Use `alert.type` to narrow the union to a specific alert shape.
 */
export type SyncAlert =
  | ConnectionChangedAlert
  | QueueDepthThresholdAlert
  | SyncLagThresholdAlert;

// ---------------------------------------------------------------------------
// Metric sink adapter contract
// ---------------------------------------------------------------------------

/**
 * Pluggable adapter for emitting health metrics and alerts.
 *
 * Consumers provide a concrete implementation that routes metrics
 * and alerts to their monitoring infrastructure (e.g. logs, dashboards,
 * APM systems).
 */
export interface IMetricSink {
  /** Emits a point-in-time health metrics snapshot. */
  emit(metrics: SyncHealthMetrics): void;

  /** Emits a sync alert for an exceeded threshold or state change. */
  emitAlert(alert: SyncAlert): void;
}
