import type {
  CommitProjectionSourceCommitRequest, ProjectionSourceCommitDocument,
  ProjectionUuidBase64Url22, VerifiedProjectionSourceCommitStatePatch
} from '@redemeine/projection-runtime-core';
import type { AnyBulkWriteOperation, ClientSession } from 'mongodb';
import type { MongoProjectionStoreOptions, MongoSourceCommitPatchDecision, ProjectionDocumentRecord } from '../types';
import { planSourceDocumentWrite } from './sourceCommitDelta';
import { majorityPrimary, type LoadedSourceSnapshot } from './sourceCommitSnapshot';
import { sourceCommitChunks } from './sourceCommitMembership';

export function revisionFilter(id: string, revision: number | null): Record<string, unknown> {
  return { _id: id, v2Revision: revision === null ? { $exists: false } : revision };
}

export function didWrite(result: unknown): boolean {
  const counts = result as { matchedCount?: number; upsertedCount?: number; acknowledged?: boolean };
  return counts.acknowledged !== false && (counts.matchedCount === 1 || counts.upsertedCount === 1);
}

interface DocumentWrite {
  id: string;
  revision: number;
  writeId: string;
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  insertOnly: boolean;
  legacy: boolean;
  decision: MongoSourceCommitPatchDecision;
}

function applyLegacyFence<TState>(
  document: ProjectionSourceCommitDocument<TState>, row: ProjectionDocumentRecord<TState> | null | undefined,
  filter: Record<string, unknown>, metadata: Partial<ProjectionDocumentRecord<TState>>, recording: boolean
): boolean {
  const legacy = document.legacyOriginal;
  if (document.expectedRevision === null && legacy) {
    const checkpoint = legacy.checkpoint as ProjectionDocumentRecord<TState>['checkpoint'];
    filter.state = recording ? { $eq: legacy.state } : legacy.state;
    filter.updatedAt = 'updatedAt' in legacy ? legacy.updatedAt : { $exists: false };
    filter.checkpoint = 'checkpoint' in legacy ? checkpoint : { $exists: false };
    metadata.v2LegacyCheckpoint = checkpoint ?? null;
    metadata.v2LegacyCheckpointPresent = 'checkpoint' in legacy;
  } else if (row?.v2ObservedUpdatedAt !== undefined) {
    filter.updatedAt = row.v2ObservedUpdatedAt;
    filter.checkpoint = row.v2LegacyCheckpointPresent ? row.v2LegacyCheckpoint : { $exists: false };
  } else return false;
  metadata.v2ObservedUpdatedAt = metadata.updatedAt!;
  return true;
}

export function planSourceDocumentWrites<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  loaded: LoadedSourceSnapshot<TState>,
  verified: ReadonlyMap<string, VerifiedProjectionSourceCommitStatePatch>,
  writeId: string,
  trusted: boolean,
  now: () => string
): readonly DocumentWrite[] {
  const progress = request.progress.strategy === 'in_document'
    ? new Map(request.progress.targets.map((target) => [target.targetDocumentId, target.final]))
    : new Map<string, Readonly<Record<ProjectionUuidBase64Url22, number>>>();
  return request.finalDocuments.map((document) => {
    const id = document.targetDocumentId;
    const row = loaded.rows.get(id);
    const revision = (document.expectedRevision ?? 0) + 1;
    const sourceProgress = progress.get(id);
    const metadata: Partial<ProjectionDocumentRecord<TState>> = {
      updatedAt: now(), v2Revision: revision, v2WriteId: writeId, ...(sourceProgress ? { sourceProgress } : {})
    };
    const insertOnly = document.expectedRevision === null && !document.legacyOriginal;
    const filter = insertOnly ? { _id: id } : revisionFilter(id, document.expectedRevision);
    const legacy = applyLegacyFence(document, row, filter, metadata, request.additionalWrites !== undefined);
    if (trusted && row) {
      // Native writers advance revision/write ID; timestamp and checkpoint also fence known legacy writers.
      filter.checkpoint = { $exists: false };
      filter.updatedAt = row.updatedAt;
      filter.v2WriteId = row.v2WriteId ?? { $exists: false };
    }
    const plan = planSourceDocumentWrite(document, row?.state === undefined ? undefined : verified.get(id), row?.state, metadata);
    const update = insertOnly ? { $setOnInsert: plan.update.$set } : plan.update;
    return { id, revision, writeId, filter, update, insertOnly, legacy, decision: plan.decision };
  });
}

export async function executeSourceDocumentWrites<TState>(
  writes: readonly DocumentWrite[], options: MongoProjectionStoreOptions<TState>,
  recording: boolean, session?: ClientSession
): Promise<Record<string, number>> {
  const revisions = new Map<string, number>();
  for (const write of writes) {
    try {
      options.onSourceCommitPatchPlan?.({ ...write.decision, historyRecording: recording ? 'enabled' : 'disabled' });
    } catch {
      // Observability must not change the outcome of the source write.
    }
    const result = await options.collection.updateOne(write.filter, write.update, {
      upsert: write.insertOnly, ...(session ? { session } : { writeConcern: { w: 'majority' } })
    });
    const applied = write.insertOnly ? (result as { upsertedCount?: number }).upsertedCount === 1 : didWrite(result);
    if (!applied) throw new Error(`${write.legacy ? 'projection-v2-stale-legacy' : 'projection-v2-occ'}:document:${write.id}`);
    revisions.set(write.id, write.revision);
  }
  return Object.fromEntries(revisions);
}

export async function executeBatchedSourceDocuments<TState>(
  writes: readonly DocumentWrite[], options: MongoProjectionStoreOptions<TState>, recording: boolean, session: ClientSession
): Promise<Record<string, number>> {
  const groups = [writes.filter((write) => write.legacy), writes.filter((write) => !write.insertOnly && !write.legacy),
    writes.filter((write) => write.insertOnly)];
  for (const group of groups) {
    for (const chunk of sourceCommitChunks(group)) {
      await writeDocumentChunk(chunk, options, recording, session);
    }
  }
  return Object.fromEntries(writes.map(({ id, revision }) => [id, revision]));
}

async function writeDocumentChunk<TState>(
  chunk: readonly DocumentWrite[], options: MongoProjectionStoreOptions<TState>, recording: boolean, session: ClientSession
): Promise<void> {
  const operations: AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>[] = chunk.map((write) => {
    try {
      options.onSourceCommitPatchPlan?.({ ...write.decision, historyRecording: recording ? 'enabled' : 'disabled' });
    } catch {
      // Observability must not change the source write.
    }
    return { updateOne: { filter: write.filter, update: write.update, upsert: write.insertOnly } };
  });
  const counts = await options.collection.bulkWrite(operations, { session, ordered: true }) as
    { matchedCount: number; upsertedCount: number };
  const insert = chunk[0]?.insertOnly;
  if (counts.matchedCount !== (insert ? 0 : chunk.length) || counts.upsertedCount !== (insert ? chunk.length : 0)) {
    throw new Error(`${chunk[0]?.legacy ? 'projection-v2-stale-legacy' : 'projection-v2-occ'}:document-batch`);
  }
}

export async function confirmSingleSourceWrite<TState>(
  write: DocumentWrite, options: MongoProjectionStoreOptions<TState>
): Promise<boolean> {
  const row = await options.collection.findOne({ _id: write.id }, { ...majorityPrimary, projection: { v2WriteId: 1, v2Revision: 1 } });
  return row?.v2WriteId === write.writeId && row.v2Revision === write.revision;
}
