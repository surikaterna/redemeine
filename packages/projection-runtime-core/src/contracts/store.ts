import type { Checkpoint } from '../types';

export interface ProjectionStoreAtomicManyCommittedResult {
  status: 'committed';
  highestWatermark: Checkpoint;
  byLaneWatermark?: Readonly<Record<string, Checkpoint>>;
  committedCount: number;
}

export interface ProjectionStoreAtomicManyRejectedResult {
  status: 'rejected';
  highestWatermark: null;
  byLaneWatermark?: Readonly<Record<string, Checkpoint>>;
  failedAtIndex: number;
  failure: ProjectionStoreWriteFailure;
  reason: string;
  committedCount: 0;
}

export type ProjectionStoreAtomicManyResult =
  | ProjectionStoreAtomicManyCommittedResult
  | ProjectionStoreAtomicManyRejectedResult;

export type ProjectionDocumentWriteMode = 'full' | 'patch';

export type ProjectionStoreFailureCategory = 'conflict' | 'transient' | 'terminal';

export interface ProjectionStoreWriteFailure {
  category: ProjectionStoreFailureCategory;
  code: string;
  message: string;
  /**
   * Deterministic retryability by category:
   * - conflict/transient: true
   * - terminal: false
   */
  retryable: boolean;
}

/**
 * OCC preconditions for a single document write.
 *
 * expectedRevision maps to current document checkpoint.sequence.
 */
export interface ProjectionStoreWritePrecondition {
  expectedRevision?: number | null;
  expectedCheckpoint?: Checkpoint | null;
}

export interface ProjectionStoreFullDocumentWrite<TState = unknown> {
  documentId: string;
  mode: 'full';
  fullDocument: TState;
  checkpoint: Checkpoint;
  precondition?: ProjectionStoreWritePrecondition;
}

export interface ProjectionStorePatchDocumentWrite {
  documentId: string;
  mode: 'patch';
  patch: Record<string, unknown>;
  checkpoint: Checkpoint;
  precondition?: ProjectionStoreWritePrecondition;
}

export type ProjectionStoreDocumentWrite<TState = unknown> =
  | ProjectionStoreFullDocumentWrite<TState>
  | ProjectionStorePatchDocumentWrite;

/**
 * Durable dedupe updates that must persist with projection writes.
 */
export interface ProjectionStoreDedupeWrite {
  upserts: ReadonlyArray<{ key: string; checkpoint: Checkpoint }>;
}

export interface ProjectionStoreAtomicWrite<TState = unknown> {
  routingKeySource: `${string}:${string}`;
  documents: ReadonlyArray<ProjectionStoreDocumentWrite<TState>>;
  dedupe: ProjectionStoreDedupeWrite;
}

export interface ProjectionStoreCommitAtomicManyRequest<TState = unknown> {
  mode: 'atomic-all';
  writes: ReadonlyArray<ProjectionStoreAtomicWrite<TState>>;
}

export interface ProjectionStoreContract<TState = unknown> {
  commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult>;

  getDedupeCheckpoint(key: string): Promise<Checkpoint | null>;
}

export interface ProjectionStoreDurableDedupeContract {
  getDedupeCheckpoint(key: string): Promise<Checkpoint | null>;
}

export interface ProjectionStoreAtomicManyContract<TState = unknown> {
  commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult>;
}

export interface ProjectionStoreWriteWatermark {
  checkpoint: Checkpoint;
}
