export type {
  Checkpoint,
  IProjectionStore,
  IProjectionLinkStore
} from './contracts';

export type {
  MongoCollectionLike,
  MongoProjectionStoreOptions,
  MongoProjectionLinkStoreOptions,
  ProjectionDocumentRecord,
  ProjectionLinkRecord
} from './types';

export { MongoProjectionStore } from './MongoProjectionStore';
export { MongoProjectionLinkStore, toLinkId } from './MongoProjectionLinkStore';
