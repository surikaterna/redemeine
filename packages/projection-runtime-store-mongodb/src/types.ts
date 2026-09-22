import type { AnyBulkWriteOperation, BulkWriteOptions, ClientSession, DeleteOptions, Document, FindOptions, MongoClient, TransactionOptions, UpdateOptions } from 'mongodb';
import type { ProjectionUuidBase64Url22 } from '@redemeine/projection-runtime-core';
import type { Checkpoint } from './contracts';

export interface ProjectionDocumentRecord<TState = unknown> {
  _id: string;
  state: TState;
  checkpoint?: Checkpoint;
  updatedAt: string;
  v2Revision?: number;
  sourceProgress?: Readonly<Record<ProjectionUuidBase64Url22, number>>;
}

export interface ProjectionLinkRecord {
  _id: string;
  aggregateType: string;
  aggregateId: string;
  targetDocId: string | null;
  createdAt: string;
  v2Revision?: number;
}

export interface ProjectionDedupeRecord {
  _id: string;
  checkpoint: Checkpoint;
  updatedAt: string;
  projectionName?: string;
  projectionGeneration?: string;
  sourceId?: string;
  commitSequence?: number;
}

export interface MongoCollectionLike<TDocument extends Document = Document> {
  findOne(filter: Record<string, unknown>, options?: FindOptions<TDocument>): Promise<TDocument | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
    options?: Pick<UpdateOptions, 'upsert' | 'session'>
  ): Promise<unknown>;
  bulkWrite(operations: ReadonlyArray<AnyBulkWriteOperation<TDocument>>, options?: Pick<BulkWriteOptions, 'ordered' | 'session'>): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>, options?: Pick<DeleteOptions, 'session'>): Promise<unknown>;
  createIndex(
    keys: Record<string, 1 | -1>,
    options: { name: string; unique: boolean; partialFilterExpression?: Record<string, unknown> }
  ): Promise<string>;
  listIndexes(): { toArray(): Promise<Array<Record<string, unknown>>> };
}

export type MongoClientLike = Pick<MongoClient, 'startSession'>;

export interface MongoProjectionStoreOptions<TState = unknown> {
  collection: MongoCollectionLike<ProjectionDocumentRecord<TState>>;
  linkCollection: MongoCollectionLike<ProjectionLinkRecord>;
  dedupeCollection: MongoCollectionLike<ProjectionDedupeRecord>;
  mongoClient: MongoClientLike;
  transactionOptions?: TransactionOptions;
  now?: () => string;
  patchPlanTelemetry?: (event: MongoPatchPlanTelemetryEvent) => void;
  patchPlanCacheMaxEntries?: number;
  onDedupeWarning?: (warning: MongoProjectionDedupeWarning) => void;
  sourceCommitTransactionExecutor?: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  onSourceCommitReconciliation?: (event: MongoSourceCommitReconciliation) => void;
}

export interface MongoSourceCommitReconciliation {
  strategy: 'in_document' | 'own_record' | 'none';
  outcome: 'committed' | 'ambiguous';
}

export interface MongoProjectionDedupeWarning {
  projectionName: string;
  projectionGeneration: string;
  targetDocumentId: string;
  kind: 'source_count' | 'metadata_bytes';
  observed: number;
  threshold: number;
}

export interface MongoProjectionLinkStoreOptions {
  collection: MongoCollectionLike<ProjectionLinkRecord>;
  now?: () => string;
}

export type MongoPatchPlanMode = 'compiled-update-document' | 'compiled-update-pipeline' | 'fallback-full-document';

export interface MongoPatchPlanTelemetryEvent {
  documentId: string;
  mode: MongoPatchPlanMode;
  fallbackReason?: string;
  cacheKey: string;
  cacheHit: boolean;
  patchLength: number;
}
