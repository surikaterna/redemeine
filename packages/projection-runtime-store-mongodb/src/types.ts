import type { Checkpoint } from './contracts';

export interface ProjectionDocumentRecord<TState = unknown> {
  _id: string;
  state: TState;
  checkpoint: Checkpoint;
  updatedAt: string;
}

export interface ProjectionLinkRecord {
  _id: string;
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
  createdAt: string;
}

export interface MongoCollectionLike<TDocument> {
  findOne(filter: Record<string, unknown>): Promise<TDocument | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
}

export interface MongoProjectionStoreOptions<TState = unknown> {
  collection: MongoCollectionLike<ProjectionDocumentRecord<TState>>;
  now?: () => string;
}

export interface MongoProjectionLinkStoreOptions {
  collection: MongoCollectionLike<ProjectionLinkRecord>;
  now?: () => string;
}
