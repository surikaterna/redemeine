import { randomUUID } from 'node:crypto';
import type {
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { validateCommitProjectionSourceCommitRelationships } from '@redemeine/projection-runtime-core';
import { BSON, type ClientSession, type TransactionOptions, type UpdateOptions } from 'mongodb';
import type { Checkpoint, IProjectionStore, ProjectionStoreAtomicManyResult, ProjectionStoreCommitAtomicManyRequest } from './contracts';
import { commitAtomicMany } from './store/commitAtomicMany';
import { buildDocumentWriteOperation } from './store/documentWriteOperationBuilder';
import { persistCommitAtomicWithBulkWrite } from './store/persistCommitAtomicWithBulkWrite';
import { isUnknownSourceCommitOutcome, readSourceCommitChange } from './store/sourceCommitChanges';
import { ensureSourceCommitStoreReady } from './store/sourceCommitReadiness';
import { commitMongoV2 } from './store/sourceCommitV2';
import { matchesSourceSnapshot, protectSourceSnapshot, readMongoSourceSnapshot, type NativeSourceSnapshot } from './store/sourceCommitSnapshot';
import { createTransactionExecutor, type TransactionExecutor } from './store/transactionExecutor';
import { withSession } from './store/withSession';
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
  private readonly sourceSnapshots = new WeakMap<ProjectionSourceCommitSnapshot<TState>, NativeSourceSnapshot<TState>>();
  private readonly emittedDedupeWarnings = new Set<string>();

  constructor(private readonly options: MongoProjectionStoreOptions<TState>) {
    this.now = options.now ?? defaultNow;
    this.patchPlanTelemetry = options.patchPlanTelemetry;
    this.patchPlanCacheMaxEntries = options.patchPlanCacheMaxEntries ?? 512;
  }

  get projectionChangesCapability(): 'atomic-turn-receipts-v1' | undefined {
    return this.options.changeCollection ? 'atomic-turn-receipts-v1' : undefined;
  }

  readonly sourceCommitSnapshotCapability = 'revision-cas-v1' as const;

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

  async loadProjectionSourceCommitSnapshot(request: LoadProjectionSourceCommitSnapshotRequest): Promise<ProjectionSourceCommitSnapshot<TState>> {
    await this.initializeProjectionSourceCommitStore();
    if (request.prepareSourceCommit) {
      const loaded = await readMongoSourceSnapshot(request, this.options);
      const proof = protectSourceSnapshot(loaded, request);
      if (proof) this.sourceSnapshots.set(loaded.snapshot, proof);
      return loaded.snapshot;
    }
    if (request.changeIdentity && this.options.changeCollection) {
      if (!request.targetDocumentIds.length && !request.links.length && request.progressStrategy === 'none') {
        return (await readMongoSourceSnapshot(request, this.options)).snapshot;
      }
      return this.createTransactionExecutor()(async (session) => (await readMongoSourceSnapshot(request, this.options, session)).snapshot);
    }
    return (await readMongoSourceSnapshot(request, this.options)).snapshot;
  }

  async initializeProjectionSourceCommitStore(): Promise<void> {
    this.sourceCommitReadiness ??= ensureSourceCommitStoreReady(this.options, this.createTransactionExecutor());
    return this.sourceCommitReadiness;
  }

  async commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>, snapshot?: ProjectionSourceCommitSnapshot<TState>
  ): Promise<CommitProjectionSourceCommitResult> {
    const malformed = validateCommitProjectionSourceCommitRelationships(request)
      ?? (request.additionalWrites && !this.options.changeCollection ? 'projection_changes collection is not configured' : null);
    if (malformed) {
      return { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: malformed };
    }
    const applicationId = request.additionalWrites && request.progress.strategy === 'none' ? randomUUID() : undefined;
    try {
      await this.initializeProjectionSourceCommitStore();
      const candidate = snapshot && this.sourceSnapshots.get(snapshot);
      const proof = candidate && matchesSourceSnapshot(request, candidate) ? candidate : undefined;
      const result = await commitMongoV2(request, this.options, this.createTransactionExecutor(), proof, applicationId, snapshot !== undefined);
      if (result.status === 'committed' && !result.replayed) {
        try {
          await this.reportDedupeWarnings(request);
        } catch {
          // Measurement and telemetry are both best effort after durable commit.
        }
      }
      return result;
    } catch (error) {
      if (!isUnknownSourceCommitOutcome(error)) throw error;
      return this.reconcileUnknownCommit(request, applicationId);
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

  private async reconcileUnknownCommit(
    request: CommitProjectionSourceCommitRequest<TState>, applicationId?: string
  ): Promise<CommitProjectionSourceCommitResult> {
    if (request.additionalWrites) {
      const receipt = await readSourceCommitChange(request, this.options.changeCollection, { applicationId });
      this.reportReconciliation(request, receipt?.status === 'committed' ? 'committed' : 'ambiguous');
      if (receipt && (applicationId === undefined || receipt.status === 'committed')) return receipt;
      return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' };
    }
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
    if (!this.reconciliationSnapshotMatches(request, snapshot)) {
      this.reportReconciliation(request, 'ambiguous');
      return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' };
    }
    const documentRevisions = Object.fromEntries(request.finalDocuments.map((entry) => [entry.targetDocumentId, (entry.expectedRevision ?? 0) + 1]));
    const linkRevisions = Object.fromEntries(
      request.stagedLinks.map((entry) => [`${entry.aggregateType}:${entry.aggregateId}`, (entry.expectedRevision ?? 0) + 1])
    );
    this.reportReconciliation(request, 'committed');
    return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions, linkRevisions, progress: request.progress };
  }

  private reconciliationSnapshotMatches(request: CommitProjectionSourceCommitRequest<TState>, snapshot: ProjectionSourceCommitSnapshot<TState>): boolean {
    if (request.progress.strategy === 'none') return false;
    const markersMatch =
      request.progress.strategy === 'own_record'
        ? snapshot.ownRecordSequence === request.progress.source.finalSequence
        : request.progress.targets.every((target) => {
            const actual = snapshot.targets.find((entry) => entry.targetDocumentId === target.targetDocumentId);
            const progress = actual?.sourceProgress ?? {};
            const keys = Object.keys(progress);
            return (
              keys.length === Object.keys(target.final).length &&
              keys.every((key) => progress[key as ProjectionUuidBase64Url22] === target.final[key as ProjectionUuidBase64Url22])
            );
          });
    const documentsMatch = request.finalDocuments.every((expected) => {
      const actual = snapshot.targets.find((entry) => entry.targetDocumentId === expected.targetDocumentId);
      return actual?.revision === (expected.expectedRevision ?? 0) + 1;
    });
    const linksMatch = request.stagedLinks.every((expected, index) => snapshot.links[index]?.revision === (expected.expectedRevision ?? 0) + 1);
    return markersMatch && documentsMatch && linksMatch;
  }

  private reportReconciliation(request: CommitProjectionSourceCommitRequest<TState>, outcome: 'committed' | 'ambiguous'): void {
    try {
      this.options.onSourceCommitReconciliation?.({ strategy: request.progress.strategy, outcome });
    } catch {
      // Outcome telemetry cannot alter reconciliation.
    }
  }

  private async reportDedupeWarnings(request: CommitProjectionSourceCommitRequest<TState>): Promise<void> {
    if (request.progress.strategy !== 'in_document' || !request.progress.warnings || !this.options.onDedupeWarning) return;
    for (const target of request.progress.targets) {
      const sourceCount = Object.keys(target.final).length;
      this.emitWarning(request, target.targetDocumentId, 'source_count', sourceCount, request.progress.warnings.warnAtSourceCount);
      if (request.progress.warnings.warnAtMetadataBytes !== undefined) {
        const row = await this.options.collection.findOne({ _id: target.targetDocumentId });
        if (row) this.emitWarning(request, target.targetDocumentId, 'metadata_bytes', BSON.calculateObjectSize(row),
          request.progress.warnings.warnAtMetadataBytes);
      }
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
