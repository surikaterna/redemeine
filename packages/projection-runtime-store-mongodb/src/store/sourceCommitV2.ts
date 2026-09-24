import type { ClientSession } from 'mongodb';
import type {
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { validateCommitProjectionSourceCommitRelationships } from '@redemeine/projection-runtime-core';
import type {
  MongoProjectionStoreOptions,
  ProjectionDedupeRecord,
  ProjectionDocumentRecord,
  ProjectionLinkRecord
} from '../types';
import { isMongoPhysicalCapacityError } from './mongoCapacityError';

const scope = (name: string, generation: string): string => `${name}\u0000${generation}`;
const linkId = (name: string, generation: string, type: string, id: string): string =>
  `${scope(name, generation)}\u0000${type}\u0000${id}`;
const ownId = (name: string, generation: string, source: string): string => `${scope(name, generation)}\u0000${source}`;
type WriteResult = { matchedCount?: number; upsertedCount?: number };

const recordsEqual = (left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

const conflict = (reason: string): CommitProjectionSourceCommitResult => ({
  version: 1,
  status: 'rejected',
  category: 'conflict',
  retryable: true,
  reason
});

const revisionFilter = (id: string, revision: number | null): Record<string, unknown> =>
  revision === null ? { _id: id, v2Revision: { $exists: false } } : { _id: id, v2Revision: revision };

const didWrite = (result: unknown): boolean => {
  const write = result as WriteResult;
  return (write.matchedCount ?? 0) === 1 || (write.upsertedCount ?? 0) === 1;
};

const readDocuments = async <TState>(
  request: LoadProjectionSourceCommitSnapshotRequest,
  options: MongoProjectionStoreOptions<TState>,
  session?: ClientSession
): Promise<ProjectionSourceCommitSnapshot<TState>['targets']> => Promise.all(request.targetDocumentIds.map(async (targetDocumentId) => {
  const row = await options.collection.findOne({ _id: targetDocumentId }, session ? { session } : undefined);
  if (row?.v2ObservedUpdatedAt !== undefined && (row.updatedAt !== row.v2ObservedUpdatedAt
    || ('checkpoint' in row) !== row.v2LegacyCheckpointPresent
    || JSON.stringify(row.checkpoint ?? null) !== JSON.stringify(row.v2LegacyCheckpoint ?? null))) {
    throw new Error(`Detected legacy writer after first touch: ${targetDocumentId}`);
  }
  return {
    targetDocumentId,
    revision: row?.v2Revision ?? null,
    state: row?.state ?? null,
    sourceProgress: row?.sourceProgress ?? {},
    ...(row && row.v2Revision === undefined ? { legacyOriginal: {
      state: row.state,
      ...('updatedAt' in row ? { updatedAt: row.updatedAt } : {}),
      ...('checkpoint' in row ? { checkpoint: row.checkpoint } : {})
    } } : {})
  };
}));

const readLinks = async <TState>(
  request: LoadProjectionSourceCommitSnapshotRequest,
  options: MongoProjectionStoreOptions<TState>,
  session?: ClientSession
): Promise<ProjectionSourceCommitSnapshot<TState>['links']> => Promise.all(request.links.map(async ({ aggregateType, aggregateId }) => {
  const _id = linkId(request.projectionName, request.projectionGeneration, aggregateType, aggregateId);
  const row = await options.linkCollection.findOne({ _id }, session ? { session } : undefined);
  return { aggregateType, aggregateId, targetDocumentId: row?.targetDocId ?? null, revision: row?.v2Revision ?? null };
}));

export const loadMongoV2Snapshot = async <TState>(
  request: LoadProjectionSourceCommitSnapshotRequest,
  options: MongoProjectionStoreOptions<TState>,
  session?: ClientSession
): Promise<ProjectionSourceCommitSnapshot<TState>> => {
  const [targets, links] = await Promise.all([readDocuments(request, options, session), readLinks(request, options, session)]);
  let ownRecordSequence: number | null = null;
  if (request.progressStrategy === 'own_record' && request.sourceId !== undefined) {
    const _id = ownId(request.projectionName, request.projectionGeneration, request.sourceId);
    const row = await options.dedupeCollection.findOne({ _id }, session ? { session } : undefined);
    ownRecordSequence = row?.commitSequence ?? null;
  }
  return { targets, links, ownRecordSequence };
};

const validateSnapshot = <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  snapshot: ProjectionSourceCommitSnapshot<TState>
): string | null => {
  const documents = new Map(snapshot.targets.map((target) => [target.targetDocumentId, target]));
  for (const document of request.finalDocuments) {
    const observed = documents.get(document.targetDocumentId);
    if (observed?.revision !== document.expectedRevision) {
      return `document revision conflict for ${document.targetDocumentId}`;
    }
    if (document.legacyOriginal && JSON.stringify(observed?.legacyOriginal) !== JSON.stringify(document.legacyOriginal)) {
      return `legacy document changed before first touch: ${document.targetDocumentId}`;
    }
  }
  for (let index = 0; index < request.stagedLinks.length; index += 1) {
    const link = request.stagedLinks[index];
    if (snapshot.links[index]?.revision !== link?.expectedRevision) return `link revision conflict at ${index}`;
  }
  if (request.progress.strategy === 'own_record') {
    return snapshot.ownRecordSequence === request.progress.source.expectedSequence ? null : 'own-record sequence conflict';
  }
  if (request.progress.strategy === 'in_document') {
    for (const progress of request.progress.targets) {
      const actual = documents.get(progress.targetDocumentId)?.sourceProgress ?? {};
      if (!recordsEqual(actual, progress.expected)) return `in-document progress conflict for ${progress.targetDocumentId}`;
    }
  }
  return null;
};

const writeDocuments = async <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  session: ClientSession
): Promise<Record<string, number>> => {
  const revisions: Record<string, number> = {};
  const progress = request.progress.strategy === 'in_document'
    ? new Map(request.progress.targets.map((target) => [target.targetDocumentId, target.final]))
    : new Map<string, Readonly<Record<ProjectionUuidBase64Url22, number>>>();
  for (const document of request.finalDocuments) {
    const revision = (document.expectedRevision ?? 0) + 1;
    const updatedAt = options.now?.() ?? new Date().toISOString();
    const $set: Partial<ProjectionDocumentRecord<TState>> = {
      state: document.finalDocument,
      updatedAt,
      v2Revision: revision
    };
    if (document.legacyOriginal) {
      $set.v2LegacyCheckpoint = (document.legacyOriginal.checkpoint ?? null) as NonNullable<ProjectionDocumentRecord<TState>['checkpoint']> | null;
      $set.v2LegacyCheckpointPresent = 'checkpoint' in document.legacyOriginal;
      $set.v2ObservedUpdatedAt = updatedAt;
    }
    const sourceProgress = progress.get(document.targetDocumentId);
    if (sourceProgress !== undefined) $set.sourceProgress = sourceProgress;
    const filter = revisionFilter(document.targetDocumentId, document.expectedRevision);
    if (document.expectedRevision === null && document.legacyOriginal) {
      filter.state = document.legacyOriginal.state;
      filter.updatedAt = 'updatedAt' in document.legacyOriginal ? document.legacyOriginal.updatedAt : { $exists: false };
      filter.checkpoint = 'checkpoint' in document.legacyOriginal ? document.legacyOriginal.checkpoint : { $exists: false };
    }
    if (document.expectedRevision !== null) {
      const observed = await options.collection.findOne({ _id: document.targetDocumentId }, { session });
      if (observed?.v2ObservedUpdatedAt !== undefined) {
        filter.updatedAt = observed.v2ObservedUpdatedAt;
        filter.checkpoint = observed.v2LegacyCheckpointPresent ? observed.v2LegacyCheckpoint : { $exists: false };
        $set.v2ObservedUpdatedAt = updatedAt;
      }
    }
    const result = await options.collection.updateOne(
      filter,
      { $set },
      { upsert: document.expectedRevision === null && !document.legacyOriginal, session }
    );
    if (!didWrite(result)) throw new Error(`${document.legacyOriginal || $set.v2ObservedUpdatedAt ? 'projection-v2-stale-legacy' : 'projection-v2-occ'}:document:${document.targetDocumentId}`);
    revisions[document.targetDocumentId] = revision;
  }
  return revisions;
};

const writeLinks = async <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  session: ClientSession
): Promise<Record<string, number>> => {
  const revisions: Record<string, number> = {};
  for (const link of request.stagedLinks) {
    const _id = linkId(request.projectionName, request.projectionGeneration, link.aggregateType, link.aggregateId);
    const revision = (link.expectedRevision ?? 0) + 1;
    const record: Partial<ProjectionLinkRecord> = {
      aggregateType: link.aggregateType,
      aggregateId: link.aggregateId,
      targetDocId: link.operation === 'subscribe' ? link.targetDocumentId : null,
      createdAt: options.now?.() ?? new Date().toISOString(),
      v2Revision: revision
    };
    const result = await options.linkCollection.updateOne(
      revisionFilter(_id, link.expectedRevision),
      { $set: record },
      { upsert: link.expectedRevision === null, session }
    );
    if (!didWrite(result)) throw new Error(`projection-v2-occ:link:${_id}`);
    revisions[`${link.aggregateType}:${link.aggregateId}`] = revision;
  }
  return revisions;
};

const writeOwnProgress = async <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  session: ClientSession
): Promise<void> => {
  if (request.progress.strategy !== 'own_record') return;
  const source = request.progress.source;
  const _id = ownId(request.projectionName, request.projectionGeneration, source.sourceId);
  const filter = source.expectedSequence === null
    ? { _id, commitSequence: { $exists: false } }
    : { _id, commitSequence: source.expectedSequence };
  const record: Partial<ProjectionDedupeRecord> = {
    projectionName: request.projectionName,
    projectionGeneration: request.projectionGeneration,
    sourceId: source.sourceId,
    commitSequence: source.finalSequence,
    updatedAt: options.now?.() ?? new Date().toISOString()
  };
  const seed = source.expectedSequence === null && source.baselineSequence !== undefined
    ? { $setOnInsert: { acceptedBaselineSequence: source.baselineSequence } } : {};
  const result = await options.dedupeCollection.updateOne(filter, { $set: record, ...seed },
    { upsert: source.expectedSequence === null, session });
  if (!didWrite(result)) throw new Error('projection-v2-occ:own-record');
};

const snapshotForCommit = <TState>(request: CommitProjectionSourceCommitRequest<TState>): LoadProjectionSourceCommitSnapshotRequest => ({
  projectionName: request.projectionName,
  projectionGeneration: request.projectionGeneration,
  targetDocumentIds: request.finalDocuments.map((entry) => entry.targetDocumentId),
  links: request.stagedLinks.map(({ aggregateType, aggregateId }) => ({ aggregateType, aggregateId })),
  progressStrategy: request.progress.strategy,
  ...(request.progress.strategy === 'own_record' ? { sourceId: request.progress.source.sourceId } : {})
});

const lacksLegacyOriginal = <TState>(request: CommitProjectionSourceCommitRequest<TState>,
  snapshot: ProjectionSourceCommitSnapshot<TState>): boolean => request.finalDocuments.some((document) =>
    document.expectedRevision === null && !document.legacyOriginal
    && snapshot.targets.some((target) => target.targetDocumentId === document.targetDocumentId && target.legacyOriginal));

export const commitMongoV2 = async <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  execute: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>
): Promise<CommitProjectionSourceCommitResult> => {
  const malformed = validateCommitProjectionSourceCommitRelationships(request);
  if (malformed) {
    return { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: malformed };
  }
  try {
    return await execute(async (session) => {
      const snapshot = await loadMongoV2Snapshot(snapshotForCommit(request), options, session);
      if (lacksLegacyOriginal(request, snapshot)) {
        return { version: 1, status: 'rejected', category: 'terminal', retryable: false,
          reason: 'Legacy document first touch requires original state CAS.' };
      }
      const failure = validateSnapshot(request, snapshot);
      if (failure) return failure.startsWith('legacy document changed')
        ? { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: failure }
        : conflict(failure);
      const documentRevisions = await writeDocuments(request, options, session);
      const linkRevisions = await writeLinks(request, options, session);
      await writeOwnProgress(request, options, session);
      return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions, linkRevisions, progress: request.progress };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Detected legacy writer after first touch:')) {
      return { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: error.message };
    }
    if (request.finalDocuments.some((document) => document.legacyOriginal) && error instanceof Error) {
      return { version: 1, status: 'rejected', category: 'terminal', retryable: false,
        reason: `First-touch transaction outcome requires operator inspection: ${error.message}` };
    }
    if (error instanceof Error && error.message.startsWith('projection-v2-stale-legacy:')) {
      return { version: 1, status: 'rejected', category: 'terminal', retryable: false, reason: error.message };
    }
    if (error instanceof Error && error.message.startsWith('projection-v2-occ:')) return conflict(error.message);
    if (isMongoPhysicalCapacityError(error)) {
      return {
        version: 1,
        status: 'rejected',
        category: 'terminal',
        retryable: false,
        reason: 'MongoDB physical BSON/document capacity exceeded'
      };
    }
    throw error;
  }
};
