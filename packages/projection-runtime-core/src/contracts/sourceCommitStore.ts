import type { ProjectionSourceCommit } from './sourceCommit';
import { isProjectionSha256Digest } from './registry';
import type { ProjectionUuidBase64Url22 } from './uuidCodec';

export interface ProjectionSourceCommitDocument<TState = unknown> {
  targetDocumentId: string;
  expectedRevision: number | null;
  finalDocument: TState;
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

export interface ProjectionMigrationCommitReceipt {
  migrationId: string;
  manifestDigest: `sha256:${string}`;
  sourceId: string;
  expectedSequence: number | null;
  finalSequence: number;
}

export interface CommitProjectionSourceCommitRequest<TState = unknown> {
  version: 1;
  mode: 'atomic-all';
  projectionName: string;
  projectionGeneration: string;
  commit: ProjectionSourceCommit;
  finalDocuments: readonly ProjectionSourceCommitDocument<TState>[];
  stagedLinks: readonly ProjectionSourceCommitLink[];
  progress: ProjectionSourceCommitProgress;
  /** Migration-only atomic replay checkpoint. Ordinary runtime requests omit this field. */
  migrationReceipt?: ProjectionMigrationCommitReceipt;
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
  loadProjectionMigrationReceipt?(request: {
    migrationId: string;
    manifestDigest: `sha256:${string}`;
    projectionName: string;
    projectionGeneration: string;
    sourceId: string;
  }): Promise<number | null>;
}

export function validateCommitProjectionSourceCommitRelationships<TState>(
  request: CommitProjectionSourceCommitRequest<TState>
): string | null {
  const receipt = request.migrationReceipt;
  if (receipt && (receipt.migrationId.trim().length === 0 || !isProjectionSha256Digest(receipt.manifestDigest)
    || receipt.sourceId !== request.commit.streamId || receipt.finalSequence !== request.commit.commitSequence
    || receipt.expectedSequence !== (receipt.finalSequence === 0 ? null : receipt.finalSequence - 1))) {
    return 'migration receipt must match the contiguous source commit boundary';
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
