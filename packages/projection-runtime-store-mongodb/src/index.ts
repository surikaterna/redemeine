export type {
  Checkpoint,
  ProjectionAtomicWrite,
  ProjectionDedupeWrite,
  IProjectionStore,
  IProjectionLinkStore,
  ProjectionStoreAtomicManyCommittedResult,
  ProjectionStoreAtomicManyRejectedResult,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreRfc6902Operation,
  ProjectionStoreFailureCategory,
  ProjectionStoreWriteFailure,
  ProjectionStoreWritePrecondition,
  ProjectionStoreFullDocumentWrite,
  ProjectionStorePatchDocumentWrite,
  ProjectionStoreDocumentWrite,
  ProjectionStoreDedupeWrite,
  ProjectionStoreAtomicWrite,
  ProjectionStoreCommitAtomicManyRequest
} from './contracts';

export type {
  MongoCollectionLike,
  MongoProjectionStoreOptions,
  MongoPatchPlanTelemetryEvent,
  MongoPatchPlanMode,
  MongoProjectionLinkStoreOptions,
  ProjectionDocumentRecord,
  ProjectionDedupeRecord,
  ProjectionLinkRecord
} from './types';

export { MongoProjectionStore } from './MongoProjectionStore';
export { MongoProjectionLinkStore, toLinkId } from './MongoProjectionLinkStore';
export {
  patch6902ToMongoUpdatePlan
} from './patch6902ToMongoUpdatePlan';
export type {
  MongoPatchCompiledPlan,
  MongoPatchFallbackPlan,
  MongoPatchUpdatePlan
} from './patch6902ToMongoUpdatePlan';
