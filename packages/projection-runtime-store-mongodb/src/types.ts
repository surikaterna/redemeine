import type { AnyBulkWriteOperation, BulkWriteOptions, Collection, DeleteOptions, Document, FindOptions, MongoClient, TransactionOptions, UpdateOptions } from 'mongodb';
import type {
  CommitProjectionSourceCommitCommitted,
  JoinSeedEdge,
  ProjectionChangesReceipt,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import type { Checkpoint } from './contracts';

export interface ProjectionDocumentRecord<TState = unknown> {
  _id: string;
  state: TState;
  checkpoint?: Checkpoint;
  updatedAt: string;
  v2Revision?: number;
  /** Unique per successful native write, preventing revision reuse across delete/recreate and resolving uncertain single writes. */
  v2WriteId?: string;
  sourceProgress?: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  v2LegacyCheckpoint?: Checkpoint | null;
  v2LegacyCheckpointPresent?: boolean;
  v2ObservedUpdatedAt?: string;
}

export interface ProjectionLinkRecord {
  _id: string;
  aggregateType: string;
  aggregateId: string;
  targetDocId: string | null;
  createdAt: string;
  v2Revision?: number;
}

export interface ProjectionJoinMembershipRecord {
  _id: string;
  format: 'set-v1';
  aggregateType: string;
  aggregateId: string;
  targetDocumentIds: readonly string[];
  revision: number;
  seeds?: readonly JoinSeedEdge[];
}

export interface ProjectionDedupeRecord {
  _id: string;
  checkpoint: Checkpoint;
  updatedAt: string;
  projectionName?: string;
  projectionGeneration?: string;
  sourceId?: string;
  commitSequence?: number;
  acceptedBaselineSequence?: number;
  /** Identifies the atomic set turn, not just its source sequence. */
  v2WriteId?: string;
}

type RevisionEntry = readonly [key: string, revision: number];
type LegacyRevisionMaps = Pick<CommitProjectionSourceCommitCommitted, 'documentRevisions' | 'linkRevisions'>;

export type MongoProjectionChangesRecord = ProjectionChangesReceipt & {
  _id: string;
  outcome: Pick<CommitProjectionSourceCommitCommitted, 'progress'> & {
    /** Internal invocation marker for reliable unknown-outcome reconciliation; absent in older receipts. */
    writeId?: string;
  } & ({
    /** IDs are values here so BSON cannot reinterpret them as field names. */
    documentRevisionEntries: readonly RevisionEntry[];
    linkRevisionEntries: readonly RevisionEntry[];
  } | LegacyRevisionMaps);
};

export interface MongoCollectionLike<TDocument extends Document = Document> {
  findOne(filter: Record<string, unknown>, options?: FindOptions<TDocument>): Promise<TDocument | null>;
  find?: Collection<TDocument>['find'];
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
    options?: Pick<UpdateOptions, 'upsert' | 'session' | 'writeConcern'>
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
  /** Dedicated collection, never shared with scalar links or other projection resources. */
  joinMembershipCollection?: Pick<Collection<ProjectionJoinMembershipRecord>, 'find' | 'bulkWrite' | 'namespace'>;
  dedupeCollection: MongoCollectionLike<ProjectionDedupeRecord>;
  /** Dedicated projection_changes collection on the same transactional deployment. */
  changeCollection?: Pick<MongoCollectionLike<MongoProjectionChangesRecord>, 'findOne' | 'updateOne'>;
  mongoClient: MongoClientLike;
  transactionOptions?: TransactionOptions;
  now?: () => string;
  patchPlanTelemetry?: (event: MongoPatchPlanTelemetryEvent) => void;
  patchPlanCacheMaxEntries?: number;
  onDedupeWarning?: (warning: MongoProjectionDedupeWarning) => void;
  onSourceCommitReconciliation?: (event: MongoSourceCommitReconciliation) => void;
  /** Native write decisions (including retries); excludes target IDs, paths, and values. */
  onSourceCommitPatchPlan?: (event: MongoSourceCommitPatchPlanEvent) => void;
}

export type MongoSourceCommitPatchDecision =
  | { mode: 'metadata-only' | 'delta' }
  | { mode: 'full'; reason: 'creation' | 'legacy-fence' | 'missing-state-patch' | 'invalid-state-patch'
      | 'nonportable-state' | 'unrepresentable-patch' | 'unsafe-delta' | 'modifier-capacity' };

export type MongoSourceCommitPatchPlanEvent = MongoSourceCommitPatchDecision & {
  historyRecording: 'enabled' | 'disabled';
};

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
