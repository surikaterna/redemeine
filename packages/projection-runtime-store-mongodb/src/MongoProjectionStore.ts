import type { ClientSession, UpdateOptions } from 'mongodb';
import type {
  Checkpoint,
  IProjectionStore,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest
} from './contracts';
import type {
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';
import { commitAtomicMany } from './store/commitAtomicMany';
import { buildDocumentWriteOperation } from './store/documentWriteOperationBuilder';
import { persistCommitAtomicWithBulkWrite } from './store/persistCommitAtomicWithBulkWrite';
import { createTransactionExecutor, type TransactionExecutor } from './store/transactionExecutor';
import { withSession } from './store/withSession';
import { commitMongoV2, loadMongoV2Snapshot } from './store/sourceCommitV2';
import type { MongoPatchPlanTelemetryEvent, MongoProjectionStoreOptions } from './types';

const defaultNow = (): string => new Date().toISOString();

/**
 * Mongo-backed projection store adapter with transaction-backed atomicity.
 */
export class MongoProjectionStore<TState = unknown> implements IProjectionStore<TState> {
  private readonly now: () => string;
  private readonly patchPlanTelemetry: ((event: MongoPatchPlanTelemetryEvent) => void) | undefined;
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
          ...(this.patchPlanTelemetry !== undefined ? { patchPlanTelemetry: this.patchPlanTelemetry } : {})
        })
    });
  }

  async loadProjectionSourceCommitSnapshot(
    request: LoadProjectionSourceCommitSnapshotRequest
  ): Promise<ProjectionSourceCommitSnapshot<TState>> {
    return loadMongoV2Snapshot(request, this.options);
  }

  async commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult> {
    try {
      return await commitMongoV2(request, this.options, this.createTransactionExecutor());
    } catch (error) {
      if (!this.isUnknownCommitOutcome(error)) throw error;
      return this.reconcileUnknownCommit(request);
    }
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

  private async saveWithSession(documentId: string, state: TState, checkpoint: Checkpoint, session?: ClientSession): Promise<void> {
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
    const transactionOptions = this.options.transactionOptions ?? {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    };
    return createTransactionExecutor(() => this.options.mongoClient.startSession(), transactionOptions);
  }

  private isUnknownCommitOutcome(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const labelled = error as Error & { hasErrorLabel?: (label: string) => boolean };
    return labelled.hasErrorLabel?.('UnknownTransactionCommitResult') === true;
  }

  private async reconcileUnknownCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult> {
    if (request.progress.strategy === 'none') {
      return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' };
    }
    const snapshot = await this.loadProjectionSourceCommitSnapshot({
      projectionName: request.projectionName,
      projectionGeneration: request.projectionGeneration,
      targetDocumentIds: request.finalDocuments.map((entry) => entry.targetDocumentId),
      links: request.stagedLinks.map(({ aggregateType, aggregateId }) => ({ aggregateType, aggregateId })),
      progressStrategy: request.progress.strategy,
      ...(request.progress.strategy === 'own_record' ? { sourceId: request.progress.source.sourceId } : {})
    });
    const markersMatch = request.progress.strategy === 'own_record'
      ? snapshot.ownRecordSequence === request.progress.source.finalSequence
      : request.progress.targets.every((target) => {
          const actual = snapshot.targets.find((entry) => entry.targetDocumentId === target.targetDocumentId);
          return JSON.stringify(actual?.sourceProgress ?? {}) === JSON.stringify(target.final);
        });
    if (!markersMatch) {
      return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' };
    }
    const documentRevisions = Object.fromEntries(request.finalDocuments.map((entry) => [entry.targetDocumentId, (entry.expectedRevision ?? 0) + 1]));
    const linkRevisions = Object.fromEntries(request.stagedLinks.map((entry) => [`${entry.aggregateType}:${entry.aggregateId}`, (entry.expectedRevision ?? 0) + 1]));
    return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions, linkRevisions, progress: request.progress };
  }
}
