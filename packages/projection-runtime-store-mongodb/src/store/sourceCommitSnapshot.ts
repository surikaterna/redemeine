import {
  isCanonicalProjectionUuid, joinMembershipKey, projectionUuidToBase64Url22,
  type CommitProjectionSourceCommitRequest, type LoadProjectionSourceCommitSnapshotRequest,
  type ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';
import type { ClientSession, FindOptions } from 'mongodb';
import type { MongoProjectionStoreOptions, ProjectionDocumentRecord } from '../types';
import { readSnapshotChangeReceipt } from './sourceCommitChanges';
import { checkedSourceCommitIds, readMongoMemberships, sourceCommitChunks } from './sourceCommitMembership';

const scope = (name: string, generation: string): string => `${name}\u0000${generation}`;
export const linkId = (name: string, generation: string, type: string, id: string): string =>
  `${scope(name, generation)}\u0000${type}\u0000${id}`;
export const ownId = (name: string, generation: string, source: string): string => `${scope(name, generation)}\u0000${source}`;
export const majorityPrimary = { readConcern: 'majority', readPreference: 'primary' } as const;

export interface LoadedSourceSnapshot<TState> {
  snapshot: ProjectionSourceCommitSnapshot<TState>;
  rows: ReadonlyMap<string, ProjectionDocumentRecord<TState> | null>;
  ownWriteId?: string;
}

async function readRows<TInput, TRow>(
  inputs: readonly TInput[], load: (input: TInput) => Promise<TRow>, session?: ClientSession
): Promise<TRow[]> {
  if (!session) return Promise.all(inputs.map(load));
  // The Mongo driver does not support parallel operations on a transaction session.
  const rows: TRow[] = [];
  for (const input of inputs) rows.push(await load(input));
  return rows;
}

function documentTarget<TState>(id: string, row: ProjectionDocumentRecord<TState> | null) {
  if (row?.v2ObservedUpdatedAt !== undefined && (row.updatedAt !== row.v2ObservedUpdatedAt
    || ('checkpoint' in row) !== row.v2LegacyCheckpointPresent
    || JSON.stringify(row.checkpoint ?? null) !== JSON.stringify(row.v2LegacyCheckpoint ?? null))) {
    throw new Error(`Detected legacy writer after first touch: ${id}`);
  }
  return {
    targetDocumentId: id, revision: row?.v2Revision ?? null, state: row?.state ?? null,
    sourceProgress: { ...row?.sourceProgress },
    ...(row && row.v2Revision === undefined ? { legacyOriginal: {
      state: row.state,
      ...('updatedAt' in row ? { updatedAt: row.updatedAt } : {}),
      ...('checkpoint' in row ? { checkpoint: row.checkpoint } : {})
    } } : {})
  };
}

function needsReceipt(request: LoadProjectionSourceCommitSnapshotRequest, snapshot: ProjectionSourceCommitSnapshot): boolean {
  const identity = request.changeIdentity;
  if (!identity) return false;
  if (!request.prepareSourceCommit) return true;
  if (request.progressStrategy === 'own_record') return (snapshot.ownRecordSequence ?? -1) >= identity.commitSequence;
  const source = projectionUuidToBase64Url22(identity.sourceId);
  return snapshot.targets.some((target) => (target.sourceProgress[source] ?? -1) >= identity.commitSequence);
}

async function readSetDocuments<TState>(ids: readonly string[], options: MongoProjectionStoreOptions<TState>,
  readOptions?: FindOptions): Promise<(readonly [string, ProjectionDocumentRecord<TState> | null])[]> {
  const rows = new Map<string, ProjectionDocumentRecord<TState>>();
  for (const chunk of sourceCommitChunks(checkedSourceCommitIds(ids, (id) => id))) {
    if (!options.collection.find) throw new Error('Join membership sets require Mongo batched document reads.');
    for (const row of await options.collection.find({ _id: { $in: chunk } }, readOptions).toArray()) rows.set(row._id, row);
  }
  return ids.map((id) => [id, rows.get(id) ?? null]);
}

export async function readMongoSourceSnapshot<TState>(
  request: LoadProjectionSourceCommitSnapshotRequest,
  options: MongoProjectionStoreOptions<TState>,
  session?: ClientSession
): Promise<LoadedSourceSnapshot<TState>> {
  const readOptions: FindOptions | undefined = session ? { session } : request.prepareSourceCommit ? majorityPrimary : undefined;
  const documents = () => request.joinMembership ? readSetDocuments(request.targetDocumentIds, options, readOptions)
    : readRows(request.targetDocumentIds, async (id) => {
    const row = await options.collection.findOne({ _id: id }, readOptions);
    return [id, row] as const;
  }, session);
  const memberships = () => readRows(request.joinMembership ? [] : request.links, async ({ aggregateType, aggregateId }) => {
    const _id = linkId(request.projectionName, request.projectionGeneration, aggregateType, aggregateId);
    const row = await options.linkCollection.findOne({ _id }, readOptions);
    return { aggregateType, aggregateId, targetDocumentId: row?.targetDocId ?? null, revision: row?.v2Revision ?? null };
  }, session);
  const [entries, links] = session ? [await documents(), await memberships()] : await Promise.all([documents(), memberships()]);
  const joinMemberships = request.joinMembership ? await readMongoMemberships(request, options, readOptions) : undefined;
  const ownRecord = request.progressStrategy === 'own_record' && request.sourceId !== undefined
    ? await options.dedupeCollection.findOne({ _id: ownId(request.projectionName, request.projectionGeneration, request.sourceId) }, readOptions)
    : null;
  const targets = entries.map(([id, row]) => documentTarget(id, row));
  const snapshot = { targets, links, ownRecordSequence: ownRecord?.commitSequence ?? null,
    ...(joinMemberships ? { joinMemberships } : {}) };
  const changeReceipt = needsReceipt(request, snapshot) ? await readSnapshotChangeReceipt(request, options.changeCollection, session) : undefined;
  return { snapshot: { ...snapshot, ...(changeReceipt ? { changeReceipt } : {}) }, rows: new Map(entries),
    ...(ownRecord?.v2WriteId !== undefined ? { ownWriteId: ownRecord.v2WriteId } : {}) };
}

function canFence<TState>(row: ProjectionDocumentRecord<TState> | null): boolean {
  return row === null || (Number.isSafeInteger(row.v2Revision) && row.v2ObservedUpdatedAt === undefined
    && isCanonicalProjectionUuid(row.v2WriteId) && !Object.hasOwn(row, 'checkpoint')
    && typeof row.updatedAt === 'string' && row.state !== undefined);
}

export interface NativeSourceSnapshot<TState> extends LoadedSourceSnapshot<TState> {
  request: LoadProjectionSourceCommitSnapshotRequest;
}

/** Capture private fences; the detached BSON state is shared under the draft-only contract. */
export function protectSourceSnapshot<TState>(
  loaded: LoadedSourceSnapshot<TState>, request: LoadProjectionSourceCommitSnapshotRequest
): NativeSourceSnapshot<TState> | undefined {
  if ([...loaded.rows.values()].some((row) => !canFence(row))) return undefined;
  const rows = new Map([...loaded.rows].map(([id, row]) => [id, row ? { ...row } : null]));
  return { rows, request: structuredClone(request), snapshot: {
    ...loaded.snapshot,
    targets: loaded.snapshot.targets.map((target) => ({ ...target, sourceProgress: { ...target.sourceProgress } })),
    links: loaded.snapshot.links.map((link) => ({ ...link })),
    ...(loaded.snapshot.joinMemberships ? { joinMemberships: loaded.snapshot.joinMemberships.map((row) =>
      ({ ...row, targetDocumentIds: [...row.targetDocumentIds] })) } : {})
  } };
}

export function matchesSourceSnapshot<TState>(request: CommitProjectionSourceCommitRequest<TState>, loaded: NativeSourceSnapshot<TState>): boolean {
  const scope = loaded.request;
  if (request.projectionName !== scope.projectionName || request.projectionGeneration !== scope.projectionGeneration
    || Boolean(request.joinMembershipFences) !== Boolean(scope.joinMembership)
    || request.progress.strategy !== scope.progressStrategy
    || (request.progress.strategy === 'own_record' && request.progress.source.sourceId !== scope.sourceId)) return false;
  if (request.additionalWrites && request.progress.strategy !== 'none' && (
    scope.changeIdentity?.sourceId !== request.commit.streamId || scope.changeIdentity.commitId !== request.commit.commitId
    || scope.changeIdentity.commitSequence !== request.commit.commitSequence
    || scope.changeIdentity.collection !== request.additionalWrites[0].collection)) return false;
  const links = new Set(loaded.snapshot.links.map(({ aggregateType, aggregateId }) => linkId(scope.projectionName, scope.projectionGeneration, aggregateType, aggregateId)));
  const memberships = new Map(loaded.snapshot.joinMemberships?.map((row) =>
    [joinMembershipKey(row.aggregateType, row.aggregateId), row.revision]));
  return request.finalDocuments.every(({ targetDocumentId }) => loaded.rows.has(targetDocumentId))
    && request.stagedLinks.every(({ aggregateType, aggregateId }) => links.has(linkId(scope.projectionName, scope.projectionGeneration, aggregateType, aggregateId)))
    && (request.joinMembershipFences ?? []).every((row) =>
      memberships.get(joinMembershipKey(row.aggregateType, row.aggregateId)) === row.expectedRevision);
}
