// Sync health and observability contracts

export type {
  PendingEventSummary,
  LaneLagMetrics,
  SyncHealthMetrics,
} from './sync-health-metrics';

export type {
  ConnectionChangedAlert,
  QueueDepthThresholdAlert,
  SyncLagThresholdAlert,
  PendingEventThresholdAlert,
  SyncAlert,
  IMetricSink,
} from './metric-sink';

export type { HealthSnapshotDependencies } from './health-snapshot';
export { captureHealthSnapshot } from './health-snapshot';

export type { SyncHealthThresholds } from './thresholds';
export { defaultThresholds, checkThresholds } from './thresholds';
