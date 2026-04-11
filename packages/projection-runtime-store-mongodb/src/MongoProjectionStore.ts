import type {
  ClientSession,
  UpdateOptions
} from 'mongodb';
import type {
  Checkpoint,
  IProjectionStore,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest
} from './contracts';
import { commitAtomicMany } from './store/commitAtomicMany';
import { buildDocumentWriteOperation } from './store/documentWriteOperationBuilder';
import { persistCommitAtomicWithBulkWrite } from './store/persistCommitAtomicWithBulkWrite';
import { createTransactionExecutor, type TransactionExecutor } from './store/transactionExecutor';
import { withSession } from './store/withSession';
import type {
  MongoPatchPlanTelemetryEvent,
  MongoProjectionStoreOptions
} from './types';

const defaultNow = (): string => new Date().toISOString();

/**
 * Mongo-backed projection store adapter with transaction-backed atomicity.
 */
export class MongoProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private readonly now: () => string;
  private readonly patchPlanTelemetry?: (event: MongoPatchPlanTelemetryEvent) => void;
  private readonly patchPlanCacheMaxEntries: number;
  private readonly patchPlanCache = new Map<
    string,
    { mode: 'compiled-update-document' | 'compiled-update-pipeline' | 'fallback-full-document'; fallbackReason?: string }
  >();

  constructor(private readonly options: MongoProjectionStoreOptions<TState>) {
    this.now = options.now ?? defaultNow;
    this.patchPlanTelemetry = options.patchPlanTelemetry;
    this.patchPlanCacheMaxEntries = options.patchPlanCacheMaxEntries ?? 512;
  }

  async load(documentId: string): Promise<TState | null> {
    const row = await this.options.collection.findOne({ _id: documentId });
    return row ? row.state : null;
  }

  async save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void> {
    await this.saveWithSession(documentId, state, checkpoint);
  }

  async delete(documentId: string): Promise<void> {
    await this.options.collection.deleteOne({ _id: documentId });
  }

  async commitAtomic(write: {
    documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
    links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
    cursorKey: string;
    cursor: Checkpoint;
    dedupe: { upserts: Array<{ key: string; checkpoint: Checkpoint }> };
  }): Promise<void> {
    const execute = this.createTransactionExecutor();

    await execute(async (session) => {
      await persistCommitAtomicWithBulkWrite(write, session, this.options, this.now);
    });
  }

  async commitAtomicMany(request: ProjectionStoreCommitAtomicManyRequest<TState>): Promise<ProjectionStoreAtomicManyResult> {
    return commitAtomicMany({
      execute: this.createTransactionExecutor(),
      request,
      collection: this.options.collection,
      dedupeCollection: this.options.dedupeCollection,
      now: this.now,
      buildDocumentWriteOperation: (write) =>
        buildDocumentWriteOperation({
          write,
          now: this.now,
          patchPlanCache: this.patchPlanCache,
          patchPlanCacheMaxEntries: this.patchPlanCacheMaxEntries,
          patchPlanTelemetry: this.patchPlanTelemetry
        })
    });
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    const row = await this.options.linkCollection.findOne({ _id: `${aggregateType}:${aggregateId}` });
    return row ? row.targetDocId : null;
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.collection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    const row = await this.options.dedupeCollection.findOne({ _id: key });
    return row ? row.checkpoint : null;
  }

  private async saveWithSession(
    documentId: string,
    state: TState,
    checkpoint: Checkpoint,
    session?: ClientSession
  ): Promise<void> {
    const updateOptions: Pick<UpdateOptions, 'upsert' | 'session'> | undefined = session
      ? withSession<Pick<UpdateOptions, 'upsert'>>({ upsert: true }, session)
      : { upsert: true };

    await this.options.collection.updateOne(
      { _id: documentId },
      {
        $set: {
          state,
          checkpoint,
          updatedAt: this.now()
        }
      },
      updateOptions
    );
  }

  private createTransactionExecutor(): TransactionExecutor {
    return createTransactionExecutor(
      () => this.options.mongoClient.startSession(),
      this.options.transactionOptions
    );
  }

}
