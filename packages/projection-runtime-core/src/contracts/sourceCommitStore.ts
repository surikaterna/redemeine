import type { ProjectionSourceCommit } from './sourceCommit';
import type { ProjectionUuidBase64Url22 } from './uuidCodec';

export interface ProjectionSourceCommitDocument<TState = unknown> {
  targetDocumentId: string;
  expectedRevision: number | null;
  finalDocument: TState;
  /** Original legacy fields observed before the first v2 write; absence is significant. */
  legacyOriginal?: ProjectionLegacyDocumentOriginal<TState>;
}

export interface ProjectionLegacyDocumentOriginal<TState> {
  state: TState;
  updatedAt?: string;
  checkpoint?: unknown;
}

export interface ProjectionSourceCommitLink {
  operation: 'subscribe' | 'unsubscribe';
  targetDocumentId: string;
  aggregateType: string;
  aggregateId: string;
  /** Revision observed while routing. Null means that no membership existed. */
  expectedRevision: number | null;
}

export interface ProjectionInDocumentTargetProgress {
  targetDocumentId: string;
  expected: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  final: Readonly<Record<ProjectionUuidBase64Url22, number>>;
}

export interface ProjectionInDocumentCommitProgress {
  strategy: 'in_document';
  targets: readonly ProjectionInDocumentTargetProgress[];
  warnings?: { warnAtSourceCount?: number; warnAtMetadataBytes?: number };
}

export interface ProjectionOwnRecordCommitProgress {
  strategy: 'own_record';
  source: {
    sourceId: string;
    expectedSequence: number | null;
    finalSequence: number;
    /** Accepted B, inserted with the first post-cutover progress row. */
    baselineSequence?: number;
  };
  warnings?: { warnAtSourceCount?: number; warnAtMetadataBytes?: number };
}

export interface ProjectionNoCommitProgress {
  strategy: 'none';
}

export type ProjectionSourceCommitProgress =
  | ProjectionInDocumentCommitProgress
  | ProjectionOwnRecordCommitProgress
  | ProjectionNoCommitProgress;

export interface CommitProjectionSourceCommitRequest<TState = unknown> {
  version: 1;
  mode: 'atomic-all';
  projectionName: string;
  projectionGeneration: string;
  commit: ProjectionSourceCommit;
  finalDocuments: readonly ProjectionSourceCommitDocument<TState>[];
  stagedLinks: readonly ProjectionSourceCommitLink[];
  progress: ProjectionSourceCommitProgress;
}

export interface CommitProjectionSourceCommitCommitted {
  version: 1;
  status: 'committed';
  commitSequence: number;
  documentRevisions: Readonly<Record<string, number>>;
  linkRevisions: Readonly<Record<string, number>>;
  progress: ProjectionSourceCommitProgress;
}

export interface CommitProjectionSourceCommitRejected {
  version: 1;
  status: 'rejected';
  category: 'conflict' | 'transient' | 'terminal';
  retryable: boolean;
  reason: string;
}

export type CommitProjectionSourceCommitResult =
  | CommitProjectionSourceCommitCommitted
  | CommitProjectionSourceCommitRejected;

export interface ProjectionSourceCommitStorePort<TState = unknown> {
  loadProjectionSourceCommitSnapshot(
    request: LoadProjectionSourceCommitSnapshotRequest
  ): Promise<ProjectionSourceCommitSnapshot<TState>>;
  commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult>;
}

export function validateCommitProjectionSourceCommitRelationships<TState>(
  request: CommitProjectionSourceCommitRequest<TState>
): string | null {
  const allowed = ['version', 'mode', 'projectionName', 'projectionGeneration', 'commit', 'finalDocuments', 'stagedLinks', 'progress'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) return 'unsupported source commit request fields';
  if (request.progress.strategy === 'own_record' && request.progress.source.baselineSequence !== undefined) {
    const source = request.progress.source;
    const baseline = source.baselineSequence;
    if (source.expectedSequence !== null || baseline === undefined || !Number.isSafeInteger(baseline)
      || baseline < -1 || baseline >= source.finalSequence) {
      return 'own-record accepted baseline must be seeded with the first post-cutover source turn';
    }
  }
  if (request.progress.strategy !== 'in_document') return null;
  const documentIds = request.finalDocuments.map((document) => document.targetDocumentId);
  const progressIds = request.progress.targets.map((target) => target.targetDocumentId);
  const documentSet = new Set(documentIds);
  const progressSet = new Set(progressIds);
  if (documentSet.size !== documentIds.length) return 'in-document request contains duplicate final document targets';
  if (progressSet.size !== progressIds.length) return 'in-document request contains duplicate progress targets';
  if (documentSet.size !== progressSet.size) return 'in-document progress targets must exactly match final document targets';
  for (const targetId of documentSet) {
    if (!progressSet.has(targetId)) return 'in-document progress targets must exactly match final document targets';
  }
  return null;
}

export interface ProjectionSourceCommitSnapshotTarget<TState = unknown> {
  targetDocumentId: string;
  revision: number | null;
  state: TState | null;
  sourceProgress: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  legacyOriginal?: ProjectionLegacyDocumentOriginal<TState>;
}

export interface ProjectionSourceCommitSnapshotLink {
  aggregateType: string;
  aggregateId: string;
  targetDocumentId: string | null;
  revision: number | null;
}

export interface LoadProjectionSourceCommitSnapshotRequest {
  projectionName: string;
  projectionGeneration: string;
  targetDocumentIds: readonly string[];
  links: readonly { aggregateType: string; aggregateId: string }[];
  progressStrategy: ProjectionSourceCommitProgress['strategy'];
  sourceId?: string;
}

export interface ProjectionSourceCommitSnapshot<TState = unknown> {
  targets: readonly ProjectionSourceCommitSnapshotTarget<TState>[];
  links: readonly ProjectionSourceCommitSnapshotLink[];
  ownRecordSequence: number | null;
}
