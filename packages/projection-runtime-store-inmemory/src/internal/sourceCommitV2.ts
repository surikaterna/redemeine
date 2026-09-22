import type {
  CommitProjectionSourceCommitRequest,
  CommitProjectionSourceCommitResult,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitSnapshot,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import { validateCommitProjectionSourceCommitRelationships } from '@redemeine/projection-runtime-core';
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
  ownProgress: Map<string, number>;
  migrationReceipts: Map<string, { manifestDigest: string; sequence: number }>;
}

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
export const migrationReceiptKey = (migrationId: string, name: string, generation: string, source: string): string =>
  `${migrationId}\u0000${scope(name, generation)}\u0000${source}`;

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
  if (request.migrationReceipt) {
    const receipt = request.migrationReceipt;
    const actual = state.migrationReceipts.get(migrationReceiptKey(receipt.migrationId, request.projectionName, request.projectionGeneration, receipt.sourceId));
    if (actual && actual.manifestDigest !== receipt.manifestDigest) return 'migration receipt manifest conflict';
    if ((actual?.sequence ?? null) !== receipt.expectedSequence) return 'migration receipt sequence conflict';
  }
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
): ProjectionSourceCommitSnapshot<TState> => ({
  targets: request.targetDocumentIds.map((targetDocumentId) => {
    const metadata = state.documentMetadata.get(documentKey(request.projectionName, request.projectionGeneration, targetDocumentId));
    return {
      targetDocumentId,
      revision: metadata?.revision ?? null,
      state: documents.get(targetDocumentId)?.state ?? null,
      sourceProgress: metadata?.sourceProgress ?? {}
    };
  }),
  links: request.links.map(({ aggregateType, aggregateId }) => {
    const link = state.links.get(linkKey(request.projectionName, request.projectionGeneration, aggregateType, aggregateId));
    return { aggregateType, aggregateId, targetDocumentId: link?.targetDocumentId ?? null, revision: link?.revision ?? null };
  }),
  ownRecordSequence: request.progressStrategy !== 'own_record' || request.sourceId === undefined
    ? null
    : state.ownProgress.get(ownKey(request.projectionName, request.projectionGeneration, request.sourceId)) ?? null
});

export const commitV2 = <TState>(
  request: CommitProjectionSourceCommitRequest<TState>,
  documents: Map<string, StoredDocument<TState>>,
  current: V2State
): { result: CommitProjectionSourceCommitResult; documents?: Map<string, StoredDocument<TState>>; state?: V2State } => {
  const malformed = validateCommitProjectionSourceCommitRelationships(request);
  if (malformed) return { result: rejectMalformed(malformed) };
  const failure = validateDocuments(request, current) ?? validateLinks(request, current) ?? validateProgress(request, current);
  if (failure) return { result: reject(failure) };
  const nextDocuments = new Map(documents);
  const state: V2State = {
    documentMetadata: new Map(current.documentMetadata),
    links: new Map(current.links),
    ownProgress: new Map(current.ownProgress),
    migrationReceipts: new Map(current.migrationReceipts)
  };
  const revisions: Record<string, number> = {};
  const linkRevisions: Record<string, number> = {};
  const progress = request.progress.strategy === 'in_document'
    ? new Map(request.progress.targets.map((target) => [target.targetDocumentId, target.final]))
    : new Map<string, Readonly<Record<ProjectionUuidBase64Url22, number>>>();
  for (const document of request.finalDocuments) {
    const revision = (document.expectedRevision ?? 0) + 1;
    const key = documentKey(request.projectionName, request.projectionGeneration, document.targetDocumentId);
    const sourceProgress = progress.get(document.targetDocumentId) ?? state.documentMetadata.get(key)?.sourceProgress ?? {};
    const checkpoint = documents.get(document.targetDocumentId)?.checkpoint;
    nextDocuments.set(document.targetDocumentId, {
      state: structuredClone(document.finalDocument),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      updatedAt: new Date().toISOString()
    });
    state.documentMetadata.set(key, { targetDocumentId: document.targetDocumentId, revision, sourceProgress: { ...sourceProgress } });
    revisions[document.targetDocumentId] = revision;
  }
  for (const link of request.stagedLinks) {
    const key = linkKey(request.projectionName, request.projectionGeneration, link.aggregateType, link.aggregateId);
    const revision = (link.expectedRevision ?? 0) + 1;
    const targetDocumentId = link.operation === 'subscribe' ? link.targetDocumentId : null;
    state.links.set(key, { targetDocumentId, revision });
    linkRevisions[`${link.aggregateType}:${link.aggregateId}`] = revision;
  }
  if (request.progress.strategy === 'own_record') {
    const source = request.progress.source;
    state.ownProgress.set(ownKey(request.projectionName, request.projectionGeneration, source.sourceId), source.finalSequence);
  }
  if (request.migrationReceipt) {
    const receipt = request.migrationReceipt;
    state.migrationReceipts.set(migrationReceiptKey(receipt.migrationId, request.projectionName, request.projectionGeneration, receipt.sourceId), {
      manifestDigest: receipt.manifestDigest, sequence: receipt.finalSequence
    });
  }
  return {
    documents: nextDocuments,
    state,
    result: { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, documentRevisions: revisions, linkRevisions, progress: request.progress }
  };
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
