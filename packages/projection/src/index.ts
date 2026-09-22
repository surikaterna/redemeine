export type { Checkpoint, ProjectionEvent, EventBatch, Cursor } from './types';
export type {
  ProjectionDedupeWarningPolicy,
  ProjectionInDocumentDeduplication,
  ProjectionOwnRecordDeduplication,
  ProjectionNoDeduplication,
  ProjectionDeduplicationStrategy
} from './deduplication';
export {
  createProjection,
  inherit
} from './createProjection';
export type {
  AggregateDefinition,
  AggregateEventPayloadMap,
  AggregateEventKeys,
  AggregateEventPayloadByKey,
  AggregateStateOf,
  InheritToken,
  InheritExtended,
  MirrorableAggregateSource,
  ProjectionContext,
  ProjectionHandler,
  ProjectionHandlers,
  ProjectionStreamDefinition,
  JoinStreamDefinition,
  ProjectionDefinition,
  ProjectionBuilder,
  ProjectionCommitDefinition,
  ProjectionCommitBuilder,
  ProjectionHooks
} from './createProjection';
export {
  reverseSemanticsContract,
  createReverseSemanticsContract
} from './reverseSemanticsContract';
export type {
  ReverseSemanticsOperation,
  ReverseSemanticsContract
} from './reverseSemanticsContract';
