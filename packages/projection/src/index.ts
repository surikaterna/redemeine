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
  ReverseSubscribeStreamDefinition,
  ProjectionDefinition,
  ProjectionBuilder
} from '@redemeine/projection-runtime-core';
export {
  planReverseSubscribe,
  planReverseRelink,
  planReverseUnsubscribe
} from './reverseSemanticsContract';
export type {
  ReverseLinkAddress,
  ReverseMutation,
  ReverseSemanticsWarning,
  ReverseSubscribeSpec,
  ReverseRelinkSpec,
  ReverseUnsubscribeSpec
} from './reverseSemanticsContract';
export { InMemoryProjectionStore, InMemoryProjectionLinkStore } from '@redemeine/projection-runtime-store-inmemory';