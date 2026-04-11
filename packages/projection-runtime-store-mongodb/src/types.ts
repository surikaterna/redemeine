import type { Checkpoint } from './contracts';
import type {
  AnyBulkWriteOperation,
  ClientSession,
  MongoClient,
  TransactionOptions,
  UpdateOptions,
  DeleteOptions,
  FindOptions,
  BulkWriteOptions
} from 'mongodb';

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

export interface ProjectionDedupeRecord {
  _id: string;
  checkpoint: Checkpoint;
  updatedAt: string;
}

export interface MongoCollectionLike<TDocument> {
  findOne(filter: Record<string, unknown>, options?: FindOptions<TDocument>): Promise<TDocument | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
    options?: Pick<UpdateOptions, 'upsert' | 'session'>
  ): Promise<unknown>;
  bulkWrite(
    operations: ReadonlyArray<AnyBulkWriteOperation<TDocument>>,
    options?: Pick<BulkWriteOptions, 'ordered' | 'session'>
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown>;
}

export type MongoClientLike = Pick<MongoClient, 'startSession'>;
export type MongoClientSessionLike = Pick<ClientSession, 'withTransaction' | 'endSession'>;

export interface MongoProjectionStoreOptions<TState = unknown> {
  collection: MongoCollectionLike<ProjectionDocumentRecord<TState>>;
  linkCollection: MongoCollectionLike<ProjectionLinkRecord>;
  dedupeCollection: MongoCollectionLike<ProjectionDedupeRecord>;
  mongoClient: MongoClientLike;
  transactionOptions?: TransactionOptions;
  now?: () => string;
}

export interface MongoProjectionLinkStoreOptions {
  collection: MongoCollectionLike<ProjectionLinkRecord>;
  now?: () => string;
}
