import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CommitProjectionSourceCommitCommitted,
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionJoinMembership,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import {
  buildProjectionChangesReceipt,
  matchProjectionChangesReceipt,
  projectionChangesHistoryFailure,
  projectionChangesIdentity,
  projectionChangesResumeToken,
  validateCommitProjectionSourceCommitRelationships,
  checkProjectionSourceCommitState,
  joinMembershipKey,
  ownProjectionState
} from '@redemeine/projection-runtime-core';
import type { StoredDocument } from './storedDocument';

export interface V2DocumentMetadata {
  targetDocumentId: string;
  revision: number;
  sourceProgress: Readonly<Record<ProjectionUuidBase64Url22, number>>;
}

export interface V2Link {
  targetDocumentId: string | null;
  revision: number;
}

export interface V2State {
  documentMetadata: Map<string, V2DocumentMetadata>;
  links: Map<string, V2Link>;
  memberships: Map<string, ProjectionJoinMembership>;
  ownProgress: Map<string, number>;
  ownBaselines: Map<string, number>;
  changes: Map<string, CommitProjectionSourceCommitCommitted>;
}

export const createV2State = (): V2State => ({
  documentMetadata: new Map(), links: new Map(), memberships: new Map(), ownProgress: new Map(), ownBaselines: new Map(), changes: new Map()
});

const scopedMembershipKey = (scope: { projectionName: string; projectionGeneration: string },
  source: { aggregateType: string; aggregateId: string }): string =>
  joinMembershipKey(scope.projectionName, scope.projectionGeneration, source.aggregateType, source.aggregateId);

export interface ProjectionDedupeWarning {
  projectionName: string;
  projectionGeneration: string;
  targetDocumentId?: string;
  kind: 'source_count' | 'metadata_bytes';
  observed: number;
  threshold: number;
}

const scope = (name: string, generation: string): string => `${name}\u0000${generation}`;
const documentKey = (name: string, generation: string, target: string): string => `${scope(name, generation)}\u0000${target}`;
const linkKey = (name: string, generation: string, type: string, id: string): string =>
  `${scope(name, generation)}\u0000${type}\u0000${id}`;
const ownKey = (name: string, generation: string, source: string): string => `${scope(name, generation)}\u0000${source}`;
const recordsEqual = (left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

const reject = (reason: string): CommitProjectionSourceCommitResult => ({
  version: 1,
  status: 'rejected',
  category: 'conflict',
  retryable: true,
  reason
});

const rejectMalformed = (reason: string): CommitProjectionSourceCommitResult => ({
  version: 1,
  status: 'rejected',
  category: 'terminal',
  retryable: false,
  reason
});

const validateDocuments = <TState>(request: CommitProjectionSourceCommitRequest<TState>, state: V2State): string | null => {
  const ids = new Set<string>();
  for (const document of request.finalDocuments) {
    if (ids.has(document.targetDocumentId)) return `duplicate document ${document.targetDocumentId}`;
    ids.add(document.targetDocumentId);
    const key = documentKey(request.projectionName, request.projectionGeneration, document.targetDocumentId);
    const actual = state.documentMetadata.get(key)?.revision ?? null;
    if (actual !== document.expectedRevision) return `document revision conflict for ${document.targetDocumentId}`;
  }
  return null;
};

const validateLinks = <TState>(request: CommitProjectionSourceCommitRequest<TState>, state: V2State): string | null => {
  for (const fence of request.joinMembershipFences ?? []) {
    const revision = state.memberships.get(scopedMembershipKey(request, fence))?.revision ?? null;
    if (revision !== fence.expectedRevision) return 'join membership revision conflict';
  }
  const keys = new Set<string>();
  for (const link of request.stagedLinks) {
    const key = linkKey(request.projectionName, request.projectionGeneration, link.aggregateType, link.aggregateId);
    if (keys.has(key)) return `duplicate link ${link.aggregateType}:${link.aggregateId}`;
    keys.add(key);
    const actual = state.links.get(key)?.revision ?? null;
    if (actual !== link.expectedRevision) return `link revision conflict for ${link.aggregateType}:${link.aggregateId}`;
  }
  return null;
};

const validateProgress = <TState>(request: CommitProjectionSourceCommitRequest<TState>, state: V2State): string | null => {
  if (request.progress.strategy === 'none') return null;
  if (request.progress.strategy === 'own_record') {
    const source = request.progress.source;
    const actual = state.ownProgress.get(ownKey(request.projectionName, request.projectionGeneration, source.sourceId)) ?? null;
    return actual === source.expectedSequence ? null : 'own-record sequence conflict';
  }
  for (const target of request.progress.targets) {
    const key = documentKey(request.projectionName, request.projectionGeneration, target.targetDocumentId);
    const actual = state.documentMetadata.get(key)?.sourceProgress ?? {};
    if (!recordsEqual(actual, target.expected)) return `in-document progress conflict for ${target.targetDocumentId}`;
  }
  return null;
};

export const loadV2Snapshot = <TState>(
  request: LoadProjectionSourceCommitSnapshotRequest,
  documents: Map<string, StoredDocument<TState>>,
  state: V2State
): ProjectionSourceCommitSnapshot<TState> => {
  const changeReceipt = snapshotChangeReceipt(request, state);
  return {
    targets: request.targetDocumentIds.map((targetDocumentId) => {
      const metadata = state.documentMetadata.get(documentKey(request.projectionName, request.projectionGeneration, targetDocumentId));
      const document = documents.get(targetDocumentId);
      const storedState = request.prepareSourceCommit && metadata && document && ownProjectionState(document.state)
        ? document.state ?? null : structuredClone(document?.state) ?? null;
      return {
        targetDocumentId,
        revision: metadata?.revision ?? null,
        state: storedState,
        sourceProgress: { ...metadata?.sourceProgress },
        ...(!metadata && document ? { legacyOriginal: {
          state: structuredClone(document.state),
          ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
          ...(document.checkpoint === undefined ? {} : { checkpoint: structuredClone(document.checkpoint) })
        } } : {})
      };
    }),
    links: (request.joinMembership ? [] : request.links).map(({ aggregateType, aggregateId }) => {
      const link = state.links.get(linkKey(request.projectionName, request.projectionGeneration, aggregateType, aggregateId));
      return { aggregateType, aggregateId, targetDocumentId: link?.targetDocumentId ?? null, revision: link?.revision ?? null };
    }),
    ...(request.joinMembership ? { joinMemberships: request.links.map((source) => {
      const row = state.memberships.get(scopedMembershipKey(request, source));
      return { ...source, revision: row?.revision ?? null, targetDocumentIds: [...(row?.targetDocumentIds ?? [])] };
    }) } : {}),
    ownRecordSequence: request.progressStrategy !== 'own_record' || request.sourceId === undefined
      ? null
      : state.ownProgress.get(ownKey(request.projectionName, request.projectionGeneration, request.sourceId)) ?? null,
    ...(changeReceipt ? { changeReceipt } : {})
  };
};

function snapshotChangeReceipt(request: LoadProjectionSourceCommitSnapshotRequest, state: V2State): ProjectionSourceCommitSnapshot['changeReceipt'] {
  if (!request.changeIdentity) return undefined;
  const identity = { ...request, ...request.changeIdentity };
  const receipt = state.changes.get(projectionChangesResumeToken(identity));
  const change = receipt?.additionalWrites?.[0] ?? receipt?.emptyChangeReceipt;
  return change ? matchProjectionChangesReceipt(identity, change) : 'missing';
}

const cloneV2State = (current: V2State): V2State => ({
  documentMetadata: new Map(current.documentMetadata),
  links: new Map(current.links),
  memberships: new Map(current.memberships),
  ownProgress: new Map(current.ownProgress),
  ownBaselines: new Map(current.ownBaselines),
  changes: current.changes
});

const applyDocuments = <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  documents: Map<string, StoredDocument<TState>>,
  state: V2State,
  verified: ReturnType<typeof checkProjectionSourceCommitState>['verified'] | undefined
): { documents: Map<string, StoredDocument<TState>>; revisions: Record<string, number> } => {
  const nextDocuments = new Map(documents);
  const revisions = new Map<string, number>();
  const progress = request.progress.strategy === 'in_document'
    ? new Map(request.progress.targets.map((target) => [target.targetDocumentId, target.final]))
    : new Map<string, Readonly<Record<ProjectionUuidBase64Url22, number>>>();
  for (const document of request.finalDocuments) {
    const revision = (document.expectedRevision ?? 0) + 1;
    const key = documentKey(request.projectionName, request.projectionGeneration, document.targetDocumentId);
    const sourceProgress = progress.get(document.targetDocumentId) ?? state.documentMetadata.get(key)?.sourceProgress ?? {};
    const stored = documents.get(document.targetDocumentId);
    const checkpoint = stored?.checkpoint;
    const proof = verified?.get(document.targetDocumentId);
    nextDocuments.set(document.targetDocumentId, {
      state: proof?.unchanged && stored?.state !== undefined ? stored.state
        : proof?.captured ? document.finalDocument : structuredClone(document.finalDocument),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      updatedAt: new Date().toISOString()
    });
    state.documentMetadata.set(key, { targetDocumentId: document.targetDocumentId, revision, sourceProgress: { ...sourceProgress } });
    revisions.set(document.targetDocumentId, revision);
  }
  return { documents: nextDocuments, revisions: Object.fromEntries(revisions) };
};

const applyLinks = <TState>(request: CommitProjectionSourceCommitRequest<TState>, state: V2State): Record<string, number> => {
  const revisions: Record<string, number> = {};
  for (const { aggregateType, aggregateId, targetDocumentIds, expectedRevision } of request.joinMembershipFences ?? []) {
    const source = { aggregateType, aggregateId };
    const revision = (expectedRevision ?? 0) + 1;
    state.memberships.set(scopedMembershipKey(request, source), { ...source, revision, targetDocumentIds: [...targetDocumentIds] });
    revisions[joinMembershipKey(aggregateType, aggregateId)] = revision;
  }
  for (const link of request.stagedLinks) {
    const key = linkKey(request.projectionName, request.projectionGeneration, link.aggregateType, link.aggregateId);
    const revision = (link.expectedRevision ?? 0) + 1;
    const targetDocumentId = link.operation === 'subscribe' ? link.targetDocumentId : null;
    state.links.set(key, { targetDocumentId, revision });
    revisions[`${link.aggregateType}:${link.aggregateId}`] = revision;
  }
  return revisions;
};

const applyProgress = <TState>(request: CommitProjectionSourceCommitRequest<TState>, state: V2State): void => {
  if (request.progress.strategy === 'own_record') {
    const source = request.progress.source;
    const key = ownKey(request.projectionName, request.projectionGeneration, source.sourceId);
    if (source.expectedSequence === null && source.baselineSequence !== undefined) state.ownBaselines.set(key, source.baselineSequence);
    state.ownProgress.set(key, source.finalSequence);
  }
};

function validateChangeSnapshot<TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  documents: Map<string, StoredDocument<TState>>,
  state: V2State,
  checkState: boolean,
  allowCapture: boolean
): { failure?: string; verified?: ReturnType<typeof checkProjectionSourceCommitState>['verified'] } {
  const snapshot = loadV2Snapshot({
    projectionName: request.projectionName, projectionGeneration: request.projectionGeneration,
    targetDocumentIds: request.finalDocuments.map((document) => document.targetDocumentId), links: [],
    progressStrategy: request.progress.strategy,
    ...(allowCapture ? { prepareSourceCommit: true } : {}),
    ...(request.progress.strategy === 'own_record' ? { sourceId: request.commit.streamId } : {})
  }, documents, state);
  const historyFailure = projectionChangesHistoryFailure(request, snapshot);
  if (historyFailure) return { failure: historyFailure };
  if (!checkState) return {};
  if (request.additionalWrites && request.finalDocuments.some((document, index) =>
    !isDeepStrictEqual(document.legacyOriginal, snapshot.targets[index]?.legacyOriginal))) {
    return { failure: 'Legacy document first touch requires matching original state CAS.' };
  }
  const { verified, failure } = checkProjectionSourceCommitState(request, snapshot, allowCapture);
  return failure ? { failure } : { verified };
}

export const commitV2 = <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  documents: Map<string, StoredDocument<TState>>,
  current: V2State,
  allowCapture = false
): { result: CommitProjectionSourceCommitResult; documents?: Map<string, StoredDocument<TState>>; state?: V2State } => {
  const malformed = validateCommitProjectionSourceCommitRelationships(request);
  if (malformed) return { result: rejectMalformed(malformed) };
  const identity = projectionChangesIdentity(request);
  if (identity && request.progress.strategy !== 'none') {
    const receipt = current.changes.get(projectionChangesResumeToken(request));
    const change = receipt?.additionalWrites?.[0] ?? receipt?.emptyChangeReceipt;
    if (receipt && change) {
      return { result: matchProjectionChangesReceipt(identity, change) === 'committed'
        ? structuredClone(receipt) : rejectMalformed('projection change source commit or collection identity mismatch') };
    }
  }
  const failure = validateDocuments(request, current) ?? validateLinks(request, current) ?? validateProgress(request, current);
  const patchCheck = request.validateStateChanges || request.additionalWrites || request.finalDocuments.some(({ statePatch }) => statePatch?.kind === 'ordered')
    ? validateChangeSnapshot(request, documents, current, failure === null, allowCapture) : {};
  if (patchCheck.failure) return { result: rejectMalformed(patchCheck.failure) };
  if (failure) return { result: reject(failure) };
  const state = cloneV2State(current);
  const appliedDocuments = applyDocuments(request, documents, state, patchCheck.verified);
  const linkRevisions = applyLinks(request, state);
  applyProgress(request, state);
  const applicationId = identity && request.progress.strategy === 'none' ? randomUUID() : undefined;
  const change = buildProjectionChangesReceipt(request, applicationId);
  const result: CommitProjectionSourceCommitCommitted = {
    version: 1, status: 'committed', commitSequence: request.commit.commitSequence,
    documentRevisions: appliedDocuments.revisions, linkRevisions, progress: request.progress,
    ...(change?.kind === 'projection_changes' ? { additionalWrites: [change] } : {}),
    ...(change?.kind === 'projection_changes_empty' ? { emptyChangeReceipt: change } : {})
  };
  if (change) current.changes.set(change.resumeToken, structuredClone(result));
  return { documents: appliedDocuments.documents, state, result };
};

export const deleteV2TargetMetadata = (state: V2State, targetDocumentId: string): void => {
  for (const [key, metadata] of state.documentMetadata) {
    if (metadata.targetDocumentId === targetDocumentId) state.documentMetadata.delete(key);
  }
};

export const collectWarnings = <TState>(request: CommitProjectionSourceCommitRequest<TState>): ProjectionDedupeWarning[] => {
  if (request.progress.strategy !== 'in_document' || !request.progress.warnings) return [];
  const warnings: ProjectionDedupeWarning[] = [];
  for (const target of request.progress.targets) {
    const count = Object.keys(target.final).length;
    const bytes = new TextEncoder().encode(JSON.stringify(target.final)).byteLength;
    const base = { projectionName: request.projectionName, projectionGeneration: request.projectionGeneration, targetDocumentId: target.targetDocumentId };
    if (request.progress.warnings.warnAtSourceCount !== undefined && count > request.progress.warnings.warnAtSourceCount) {
      warnings.push({ ...base, kind: 'source_count', observed: count, threshold: request.progress.warnings.warnAtSourceCount });
    }
    if (request.progress.warnings.warnAtMetadataBytes !== undefined && bytes > request.progress.warnings.warnAtMetadataBytes) {
      warnings.push({ ...base, kind: 'metadata_bytes', observed: bytes, threshold: request.progress.warnings.warnAtMetadataBytes });
    }
  }
  return warnings;
};
