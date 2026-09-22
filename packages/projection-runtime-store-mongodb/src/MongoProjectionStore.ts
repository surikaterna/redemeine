import { BSON, type ClientSession, type TransactionOptions, type UpdateOptions } from 'mongodb';
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
  ProjectionSourceCommitSnapshot,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { validateCommitProjectionSourceCommitRelationships } from '@redemeine/projection-runtime-core';
import { commitAtomicMany } from './store/commitAtomicMany';
import { buildDocumentWriteOperation } from './store/documentWriteOperationBuilder';
import { persistCommitAtomicWithBulkWrite } from './store/persistCommitAtomicWithBulkWrite';
import { createTransactionExecutor, type TransactionExecutor } from './store/transactionExecutor';
import { withSession } from './store/withSession';
import { commitMongoV2, loadMongoV2Snapshot } from './store/sourceCommitV2';
import { ensureSourceCommitStoreReady } from './store/sourceCommitReadiness';
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
  private sourceCommitReadiness: Promise<void> | undefined;
  private readonly emittedDedupeWarnings = new Set<string>();

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
    await this.initializeProjectionSourceCommitStore();
    return loadMongoV2Snapshot(request, this.options);
  }

  async initializeProjectionSourceCommitStore(): Promise<void> {
    this.sourceCommitReadiness ??= ensureSourceCommitStoreReady(this.options, this.createTransactionExecutor());
    return this.sourceCommitReadiness;
  }

  async commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult> {
    const malformed = validateCommitProjectionSourceCommitRelationships(request);
    if (malformed) {
      return { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: malformed };
    }
    try {
      await this.initializeProjectionSourceCommitStore();
      const result = await commitMongoV2(request, this.options, this.createTransactionExecutor());
      if (result.status === 'committed') {
        try {
          await this.reportDedupeWarnings(request);
        } catch {
          // Measurement and telemetry are both best effort after durable commit.
        }
      }
      return result;
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
    return row?.checkpoint ?? null;
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
    const transactionOptions: TransactionOptions = {
      ...this.options.transactionOptions,
      readConcern: 'snapshot',
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
      this.reportReconciliation(request, 'ambiguous');
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
          const progress = actual?.sourceProgress ?? {};
          const keys = Object.keys(progress);
          return keys.length === Object.keys(target.final).length && keys.every((key) =>
            progress[key as ProjectionUuidBase64Url22] === target.final[key as ProjectionUuidBase64Url22]
          );
        });
    const documentsMatch = request.finalDocuments.every((expected) => {
      const actual = snapshot.targets.find((entry) => entry.targetDocumentId === expected.targetDocumentId);
      return actual?.revision === (expected.expectedRevision ?? 0) + 1;
    });
    const linksMatch = request.stagedLinks.every((expected, index) =>
      snapshot.links[index]?.revision === (expected.expectedRevision ?? 0) + 1
    );
    if (!markersMatch || !documentsMatch || !linksMatch) {
      this.reportReconciliation(request, 'ambiguous');
      return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' };
    }
    const documentRevisions = Object.fromEntries(request.finalDocuments.map((entry) => [entry.targetDocumentId, (entry.expectedRevision ?? 0) + 1]));
    const linkRevisions = Object.fromEntries(request.stagedLinks.map((entry) => [`${entry.aggregateType}:${entry.aggregateId}`, (entry.expectedRevision ?? 0) + 1]));
    this.reportReconciliation(request, 'committed');
    return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions, linkRevisions, progress: request.progress };
  }

  private reportReconciliation(
    request: CommitProjectionSourceCommitRequest<TState>,
    outcome: 'committed' | 'ambiguous'
  ): void {
    try {
      this.options.onSourceCommitReconciliation?.({ strategy: request.progress.strategy, outcome });
    } catch {
      // Outcome telemetry cannot alter reconciliation.
    }
  }

  private async reportDedupeWarnings(request: CommitProjectionSourceCommitRequest<TState>): Promise<void> {
    if (request.progress.strategy !== 'in_document' || !request.progress.warnings) return;
    for (const target of request.progress.targets) {
      const row = await this.options.collection.findOne({ _id: target.targetDocumentId });
      if (!row) continue;
      const sourceCount = Object.keys(target.final).length;
      const metadataBytes = BSON.calculateObjectSize(row);
      this.emitWarning(request, target.targetDocumentId, 'source_count', sourceCount, request.progress.warnings.warnAtSourceCount);
      this.emitWarning(request, target.targetDocumentId, 'metadata_bytes', metadataBytes, request.progress.warnings.warnAtMetadataBytes);
    }
  }

  private emitWarning(
    request: CommitProjectionSourceCommitRequest<TState>,
    targetDocumentId: string,
    kind: 'source_count' | 'metadata_bytes',
    observed: number,
    threshold: number | undefined
  ): void {
    if (threshold === undefined || observed <= threshold) return;
    const key = `${request.projectionName}:${request.projectionGeneration}:${targetDocumentId}:${kind}`;
    if (this.emittedDedupeWarnings.has(key)) return;
    this.emittedDedupeWarnings.add(key);
    try {
      this.options.onDedupeWarning?.({
        projectionName: request.projectionName,
        projectionGeneration: request.projectionGeneration,
        targetDocumentId,
        kind,
        observed,
        threshold
      });
    } catch {
      // Telemetry must never alter a committed projection result.
    }
  }
}
