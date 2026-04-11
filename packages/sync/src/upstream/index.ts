// Upstream command submission — public API surface

export type {
  UpstreamCommandMetadata,
  UpstreamCommandEnvelope,
  UpstreamBatchRequest,
} from './command-envelope';

export type {
  AcceptedCommandResult,
  RejectedCommandResult,
  DuplicateCommandResult,
  UpstreamCommandResult,
  UpstreamBatchResult,
} from './batch-result';

export type { UpstreamSyncService } from './sync-service-contract';

export type {
  ConnectionState,
  ConnectionStateListener,
  Unsubscribe,
  IConnectionMonitor,
} from './connection-state';

export {
  type DrainResult,
  type DrainResultListener,
  type QueueDrainOptions,
  type QueueDrain,
  createQueueDrain,
} from './queue-drain';
