import type { ProjectionSourceCommit } from './sourceCommit';
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
}

export interface ProjectionInDocumentTargetProgress {
  targetDocumentId: string;
  expected: Readonly<Record<ProjectionUuidBase64Url22, number>>;
  final: Readonly<Record<ProjectionUuidBase64Url22, number>>;
}

export interface ProjectionInDocumentCommitProgress {
  strategy: 'in_document';
  targets: readonly ProjectionInDocumentTargetProgress[];
}

export interface ProjectionOwnRecordCommitProgress {
  strategy: 'own_record';
  source: {
    sourceId: string;
    expectedSequence: number | null;
    finalSequence: number;
  };
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
  commitProjectionSourceCommit(
    request: CommitProjectionSourceCommitRequest<TState>
  ): Promise<CommitProjectionSourceCommitResult>;
}
