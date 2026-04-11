// Store adapter contracts — public API surface

export type { EventStatus } from './event-status';
export type { StoredEvent } from './stored-event';
export type { AggregateSnapshot } from './aggregate-snapshot';

export type {
  NewEvent,
  SaveEventOptions,
  SaveEventResult,
  ConfirmResult,
  SupersedeResult,
  ReadStreamOptions,
  ISyncEventStore,
} from './sync-event-store';

export type {
  CommandMetadata,
  QueuedCommand,
  ICommandQueue,
} from './command-queue';

export type {
  SyncLane,
  Checkpoint,
  ICheckpointStore,
} from './checkpoint-store';
