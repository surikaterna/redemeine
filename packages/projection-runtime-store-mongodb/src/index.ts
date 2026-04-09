export type {
  Checkpoint,
  ProjectionAtomicWrite,
  ProjectionDedupeWrite,
  IProjectionStore,
  IProjectionLinkStore,
  ProjectionStoreAtomicManyCommittedResult,
  ProjectionStoreAtomicManyRejectedResult,
  ProjectionStoreAtomicManyResult,
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
  MongoProjectionLinkStoreOptions,
  ProjectionDocumentRecord,
  ProjectionDedupeRecord,
  ProjectionLinkRecord
} from './types';

export { MongoProjectionStore } from './MongoProjectionStore';
export { MongoProjectionLinkStore, toLinkId } from './MongoProjectionLinkStore';
