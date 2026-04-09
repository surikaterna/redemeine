export type {
  Checkpoint,
  ProjectionAtomicWrite,
  ProjectionDedupeWrite,
  IProjectionStore,
  IProjectionLinkStore
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
