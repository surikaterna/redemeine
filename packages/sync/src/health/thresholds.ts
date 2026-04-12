import type { SyncHealthMetrics } from './sync-health-metrics';
import type { SyncAlert } from './metric-sink';
import type { SyncLane } from '../manifest/lanes';
import { SYNC_LANES } from '../manifest/lanes';

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

/** Configurable thresholds for sync health alerting. */
export interface SyncHealthThresholds {
  /** Queue depth at which a warning alert is raised. */
  readonly queueDepthWarning: number;

  /** Queue depth at which a critical alert is raised. */
  readonly queueDepthCritical: number;

  /** Per-lane sync lag (ms) at which a warning alert is raised. */
  readonly syncLagWarningMs: number;

  /** Per-lane sync lag (ms) at which a critical alert is raised. */
  readonly syncLagCriticalMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Returns a threshold set with sensible defaults for typical deployments. */
export function defaultThresholds(): SyncHealthThresholds {
  return {
    queueDepthWarning: 100,
    queueDepthCritical: 500,
    syncLagWarningMs: 30_000,
    syncLagCriticalMs: 120_000,
  };
}

// ---------------------------------------------------------------------------
// Threshold checking — pure function
// ---------------------------------------------------------------------------

/**
 * Evaluates the given metrics against configured thresholds and
 * returns an array of alerts for every exceeded threshold.
 *
 * This is a pure function with no side effects.
 *
 * When both warning and critical thresholds are exceeded only the
 * critical alert is emitted to avoid duplicate noise.
 */
export function checkThresholds(
  metrics: SyncHealthMetrics,
  thresholds: SyncHealthThresholds,
): ReadonlyArray<SyncAlert> {
  const alerts: SyncAlert[] = [];
  const now = metrics.capturedAt;

  // --- Queue depth ---
  if (metrics.commandQueueDepth >= thresholds.queueDepthCritical) {
    alerts.push({
      type: 'queue_depth_threshold',
      depth: metrics.commandQueueDepth,
      threshold: thresholds.queueDepthCritical,
      timestamp: now,
    });
  } else if (metrics.commandQueueDepth >= thresholds.queueDepthWarning) {
    alerts.push({
      type: 'queue_depth_threshold',
      depth: metrics.commandQueueDepth,
      threshold: thresholds.queueDepthWarning,
      timestamp: now,
    });
  }

  // --- Per-lane sync lag ---
  for (const lane of SYNC_LANES) {
    const lagMetrics = metrics.perLaneSyncLag[lane];
    if (lagMetrics.estimatedLag === undefined) continue;

    if (lagMetrics.estimatedLag >= thresholds.syncLagCriticalMs) {
      alerts.push({
        type: 'sync_lag_threshold',
        lane,
        lag: lagMetrics.estimatedLag,
        threshold: thresholds.syncLagCriticalMs,
        timestamp: now,
      });
    } else if (lagMetrics.estimatedLag >= thresholds.syncLagWarningMs) {
      alerts.push({
        type: 'sync_lag_threshold',
        lane,
        lag: lagMetrics.estimatedLag,
        threshold: thresholds.syncLagWarningMs,
        timestamp: now,
      });
    }
  }

  return alerts;
}
