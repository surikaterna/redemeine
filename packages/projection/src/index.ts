export {
  createProjection,
  ProjectionDaemon,
  type ProjectionDaemonOptions,
  type BatchStats
} from '@redemeine/projection-runtime-core';
export type {
  Checkpoint,
  ProjectionEvent,
  EventBatch,
  Cursor,
  IProjectionStore,
  IEventSubscription,
  IProjectionLinkStore,
  AggregateDefinition,
  AggregateEventPayloadMap,
  AggregateEventKeys,
  AggregateEventPayloadByKey,
  ProjectionContext,
  ProjectionHandler,
  ProjectionHandlers,
  ProjectionStreamDefinition,
  JoinStreamDefinition,
  ProjectionDefinition,
  ProjectionBuilder
} from '@redemeine/projection-runtime-core';
export { InMemoryProjectionStore, InMemoryProjectionLinkStore } from '@redemeine/projection-runtime-store-inmemory';
