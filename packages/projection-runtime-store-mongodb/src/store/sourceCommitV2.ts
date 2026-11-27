import type { ClientSession } from 'mongodb';
import type {
  CommitProjectionSourceCommitCommitted,
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot, VerifiedProjectionSourceCommitStatePatch
} from '@redemeine/projection-runtime-core';
import {
  projectionChangesHistoryFailure,
  ProjectionJoinCapacityError,
  ProjectionJoinMembershipValidationError,
  ProjectionPersistedJoinMembershipError,
  joinMembershipKey,
  checkProjectionSourceCommitState
} from '@redemeine/projection-runtime-core';
import type {
  MongoProjectionStoreOptions,
  ProjectionDedupeRecord,
  ProjectionLinkRecord
} from '../types';
import { isMongoPhysicalCapacityError } from './mongoCapacityError';
import {
  appendSourceCommitChange,
  isTransientSourceCommitError,
  isUnknownSourceCommitOutcome,
  MongoChangeAppendValidationError,
  readSourceCommitChange
} from './sourceCommitChanges';
import {
  confirmSingleSourceWrite, didWrite, executeBatchedSourceDocuments, executeSourceDocumentWrites, planSourceDocumentWrites, revisionFilter
} from './sourceCommitDocuments';
import { linkId, ownId, readMongoSourceSnapshot, type LoadedSourceSnapshot, type NativeSourceSnapshot } from './sourceCommitSnapshot';
import { writeMongoMemberships } from './sourceCommitMembership';

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

const terminal = (reason: string): CommitProjectionSourceCommitResult => ({
  version: 1, status: 'rejected', category: 'terminal', retryable: false, reason
});

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
  const key = (type: string, id: string) => linkId(request.projectionName, request.projectionGeneration, type, id);
  const links = new Map(snapshot.links.map((link) => [key(link.aggregateType, link.aggregateId), link.revision]));
  for (const link of request.stagedLinks) {
    if (links.get(key(link.aggregateType, link.aggregateId)) !== link.expectedRevision) return 'link revision conflict';
  }
  const memberships = new Map(snapshot.joinMemberships?.map((row) =>
    [joinMembershipKey(row.aggregateType, row.aggregateId), row.revision]));
  for (const row of request.joinMembershipFences ?? []) {
    if (memberships.get(joinMembershipKey(row.aggregateType, row.aggregateId)) !== row.expectedRevision) return 'join membership revision conflict';
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
  session: ClientSession,
  writeId: string
): Promise<void> => {
  if (request.progress.strategy !== 'own_record') return;
  const source = request.progress.source;
  const _id = ownId(request.projectionName, request.projectionGeneration, source.sourceId);
  const record: Partial<ProjectionDedupeRecord> = {
    projectionName: request.projectionName,
    projectionGeneration: request.projectionGeneration,
    sourceId: source.sourceId,
    commitSequence: source.finalSequence,
    updatedAt: options.now?.() ?? new Date().toISOString(),
    ...(request.joinMembershipFences ? { v2WriteId: writeId } : {})
  };
  if (source.expectedSequence === null) {
    const seed = source.baselineSequence === undefined ? {} : { acceptedBaselineSequence: source.baselineSequence };
    const result = await options.dedupeCollection.updateOne({ _id }, { $setOnInsert: { ...record, ...seed } }, { upsert: true, session });
    if ((result as { upsertedCount?: number }).upsertedCount !== 1) throw new Error('projection-v2-occ:own-record');
  } else {
    const result = await options.dedupeCollection.updateOne(
      { _id, commitSequence: source.expectedSequence }, { $set: record }, { upsert: false, session }
    );
    if (!didWrite(result)) throw new Error('projection-v2-occ:own-record');
  }
};

export const snapshotForCommit = <TState>(request: CommitProjectionSourceCommitRequest<TState>): LoadProjectionSourceCommitSnapshotRequest => ({
  projectionName: request.projectionName,
  projectionGeneration: request.projectionGeneration,
  targetDocumentIds: request.finalDocuments.map((entry) => entry.targetDocumentId),
  links: (request.joinMembershipFences ?? request.stagedLinks).map(({ aggregateType, aggregateId }) => ({ aggregateType, aggregateId })),
  ...(request.joinMembershipFences ? { joinMembership: 'set-v1' } : {}),
  progressStrategy: request.progress.strategy,
  ...(request.progress.strategy === 'own_record' ? { sourceId: request.progress.source.sourceId } : {})
});

const lacksLegacyOriginal = <TState>(request: CommitProjectionSourceCommitRequest<TState>,
  snapshot: ProjectionSourceCommitSnapshot<TState>): boolean => request.finalDocuments.some((document) =>
    document.expectedRevision === null && !document.legacyOriginal
    && snapshot.targets.some((target) => target.targetDocumentId === document.targetDocumentId && target.legacyOriginal));

type Prepared = {
  writes: ReturnType<typeof planSourceDocumentWrites>;
};

type ObservedSourceCommit<T> = {
  loaded: NativeSourceSnapshot<T>;
  captures: ReadonlyMap<string, VerifiedProjectionSourceCommitStatePatch> | undefined;
};

function prepareSourceCommit<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  loaded: LoadedSourceSnapshot<TState>,
  writeId: string,
  captures?: ObservedSourceCommit<TState>['captures']
): Prepared | CommitProjectionSourceCommitResult {
  const ids = new Set(request.finalDocuments.map(({ targetDocumentId }) => targetDocumentId));
  const snapshot = { ...loaded.snapshot, targets: loaded.snapshot.targets.filter(({ targetDocumentId }) => ids.has(targetDocumentId)) };
  const historyFailure = projectionChangesHistoryFailure(request, snapshot);
  if (historyFailure) return terminal(historyFailure);
  if (lacksLegacyOriginal(request, snapshot)) return terminal('Legacy document first touch requires original state CAS.');
  const failure = validateSnapshot(request, snapshot);
  if (failure) return failure.startsWith('legacy document changed') ? terminal(failure) : conflict(failure);
  const { verified, failure: invalidChange } = checkProjectionSourceCommitState(request, snapshot, captures !== undefined, captures);
  if (invalidChange) return terminal(invalidChange);
  return { writes: planSourceDocumentWrites(request, loaded, verified, writeId, captures !== undefined, options.now ?? (() => new Date().toISOString())) };
}

function committed(
  request: CommitProjectionSourceCommitRequest, documentRevisions: Record<string, number>, linkRevisions: Record<string, number> = {}
): CommitProjectionSourceCommitCommitted {
  return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions, linkRevisions, progress: request.progress };
}

async function persistSourceCommit<TState>(
  request: CommitProjectionSourceCommitRequest<TState>, options: MongoProjectionStoreOptions<TState>, session: ClientSession,
  prepared: Prepared, writeId: string
): Promise<CommitProjectionSourceCommitResult> {
  const setMode = request.joinMembershipFences !== undefined;
  const documentRevisions = setMode ? await executeBatchedSourceDocuments(prepared.writes, options, Boolean(request.additionalWrites), session)
    : await executeSourceDocumentWrites(prepared.writes, options, Boolean(request.additionalWrites), session);
  const linkRevisions = setMode ? await writeMongoMemberships(request, options, session) : await writeLinks(request, options, session);
  await writeOwnProgress(request, options, session, writeId);
  return appendSourceCommitChange(request, committed(request, documentRevisions, linkRevisions), options.changeCollection, session, writeId);
}

function canWriteSingle<TState>(request: CommitProjectionSourceCommitRequest<TState>, proof: NativeSourceSnapshot<TState>): boolean {
  return request.joinMembershipFences === undefined && request.progress.strategy === 'in_document'
    && !request.additionalWrites && request.finalDocuments.length === 1
    && request.finalDocuments[0]?.expectedRevision !== null && request.stagedLinks.length === 0 && proof.request.links.length === 0;
}

async function persistSingle<TState>(
  request: CommitProjectionSourceCommitRequest<TState>, options: MongoProjectionStoreOptions<TState>, prepared: Prepared
): Promise<CommitProjectionSourceCommitResult> {
  const write = prepared.writes[0]!;
  try {
    return committed(request, await executeSourceDocumentWrites(prepared.writes, options, false));
  } catch (error) {
    if (isMongoPhysicalCapacityError(error) || (error instanceof Error && error.message.startsWith('projection-v2-occ:'))) throw error;
    try {
      if (await confirmSingleSourceWrite(write, options)) return committed(request, { [write.id]: write.revision });
    } catch {
      // An unavailable or inconclusive confirmation cannot acknowledge a write.
    }
    return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous single-document write outcome' };
  }
}

function matchesObservedFences<T>(fresh: LoadedSourceSnapshot<T>, observed: NativeSourceSnapshot<T>): boolean {
  return [...fresh.rows].every(([id, row]) => {
    const previous = observed.rows.get(id);
    return row?.v2Revision === previous?.v2Revision && row?.v2WriteId === previous?.v2WriteId && row?.updatedAt === previous?.updatedAt
      && row?.v2ObservedUpdatedAt === previous?.v2ObservedUpdatedAt
      && (!row || !Object.hasOwn(row, 'checkpoint'));
  });
}

async function runSourceCommit<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  execute: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
  observed: ObservedSourceCommit<TState> | undefined,
  writeId: string
): Promise<CommitProjectionSourceCommitResult> {
  if (observed?.captures) {
    const prepared = prepareSourceCommit(request, options, observed.loaded, writeId, observed.captures);
    if (!('writes' in prepared)) return prepared;
    if (canWriteSingle(request, observed.loaded)) return persistSingle(request, options, prepared);
    return execute((session) => persistSourceCommit(request, options, session, prepared, writeId));
  }
  return execute(async (session) => {
    const loaded = await readMongoSourceSnapshot(snapshotForCommit(request), options, session);
    if (observed && !matchesObservedFences(loaded, observed.loaded)) return conflict('projection source snapshot changed');
    const prepared = prepareSourceCommit(request, options, loaded, writeId);
    return 'writes' in prepared ? persistSourceCommit(request, options, session, prepared, writeId) : prepared;
  });
}

async function resolveMembershipReadRejection(request: CommitProjectionSourceCommitRequest,
  options: Pick<MongoProjectionStoreOptions, 'changeCollection'>,
  error: ProjectionPersistedJoinMembershipError | ProjectionJoinCapacityError): Promise<CommitProjectionSourceCommitResult> {
  if (!request.additionalWrites || request.progress.strategy === 'none') return terminal(error.message);
  // The write transaction did not apply. A different worker may already have committed this exact turn.
  try {
    const receipt = await readSourceCommitChange(request, options.changeCollection, { applicationId: undefined });
    // Valid rows can exceed the combined read budget because membership changed after planning.
    return receipt?.status === 'committed' ? { ...receipt, replayed: true }
      : receipt ?? (error instanceof ProjectionJoinCapacityError ? conflict(error.message) : terminal(error.message));
  } catch {
    return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'Unable to verify projection_changes receipt.' };
  }
}

function classifyCommitError(request: CommitProjectionSourceCommitRequest, error: unknown): CommitProjectionSourceCommitResult {
  if ((request.additionalWrites || request.joinMembershipFences) && isUnknownSourceCommitOutcome(error)) throw error;
  if ((request.additionalWrites || request.joinMembershipFences) && isTransientSourceCommitError(error)) {
    return { version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'transient MongoDB source transaction failure' };
  }
  if (error instanceof MongoChangeAppendValidationError) return terminal(error.message);
  if (error instanceof Error && error.message.startsWith('Detected legacy writer after first touch:')) return terminal(error.message);
  if (error instanceof Error && error.message === 'projection-v2-occ:projection_changes') return conflict(error.message);
  if (request.joinMembershipFences && error instanceof Error && (error.message.startsWith('projection-v2-occ:')
    || ('code' in error && error.code === 11000))) return conflict(error.message);
  if (request.finalDocuments.some((document) => document.legacyOriginal) && error instanceof Error) {
    return terminal(`First-touch transaction outcome requires operator inspection: ${error.message}`);
  }
  if (error instanceof Error && error.message.startsWith('projection-v2-stale-legacy:')) return terminal(error.message);
  if (error instanceof Error && error.message.startsWith('projection-v2-occ:')) return conflict(error.message);
  if (error instanceof Error && 'code' in error && error.code === 11000) return conflict('source commit unique key conflict');
  if (isMongoPhysicalCapacityError(error)) return terminal('MongoDB physical BSON/document capacity exceeded');
  throw error;
}

export async function commitMongoV2<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  options: MongoProjectionStoreOptions<TState>,
  execute: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
  writeId: string,
  observed?: ObservedSourceCommit<TState>,
  preparedRequest = false
): Promise<CommitProjectionSourceCommitResult> {
  // The store validates the complete request before readiness or opening a write transaction.
  let result: CommitProjectionSourceCommitResult;
  try {
    result = await runSourceCommit(request, options, execute, observed, writeId);
  } catch (error) {
    if (error instanceof ProjectionPersistedJoinMembershipError || error instanceof ProjectionJoinCapacityError) {
      return resolveMembershipReadRejection(request, options, error);
    }
    if (error instanceof ProjectionJoinMembershipValidationError) return terminal(error.message);
    result = classifyCommitError(request, error);
  }
  if (result.status === 'committed' || !request.additionalWrites) return result;
  const applicationId = request.progress.strategy === 'none' ? writeId : undefined;
  const replay = await readSourceCommitChange(request, options.changeCollection, {
    applicationId,
    // The winning set receipt can describe different recipients after membership changed.
    ...(request.joinMembershipFences !== undefined ? { recoveringWriteId: writeId } : {})
  });
  if (applicationId !== undefined) return replay?.status === 'committed' ? replay : result;
  return preparedRequest && replay?.status === 'committed' ? { ...replay, replayed: true } : replay ?? result;
}
