import type { Checkpoint } from '../types';
import type {
  ProjectionDedupeKeyEncoded,
  ProjectionDedupeRetentionPolicy
} from './dedupe';

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

export interface ProjectionStoreRfc6902Operation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

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

export interface ProjectionStorePatchDocumentWrite<TState = unknown> {
  documentId: string;
  mode: 'patch';
  /**
   * Caller-provided full document state after patch application.
   *
   * Required for stores that can safely compile patch operations to partial
   * updates and otherwise fallback to full-document writes without pre-read.
   */
  fullDocument: TState;
  /**
   * RFC6902 JSON Patch operations applied in-order.
   */
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>;
  checkpoint: Checkpoint;
  precondition?: ProjectionStoreWritePrecondition;
}

export type ProjectionStoreDocumentWrite<TState = unknown> =
  | ProjectionStoreFullDocumentWrite<TState>
  | ProjectionStorePatchDocumentWrite<TState>;

/**
 * Durable dedupe updates that must persist with projection writes.
 */
export interface ProjectionStoreDedupeWrite {
  upserts: ReadonlyArray<{ key: ProjectionDedupeKeyEncoded; checkpoint: Checkpoint }>;
}

export interface ProjectionStoreAtomicWrite<TState = unknown> {
  routingKeySource: `${string}:${string}`;
  documents: ReadonlyArray<ProjectionStoreDocumentWrite<TState>>;
  dedupe: ProjectionStoreDedupeWrite;
}

export interface ProjectionStoreCommitAtomicManyRequest<TState = unknown> {
  mode: 'atomic-all';
  /**
   * Contract invariant: at most one document write per documentId across the entire
   * atomic batch. Duplicate document writes are invalid-request terminal failures.
   */
  writes: ReadonlyArray<ProjectionStoreAtomicWrite<TState>>;
}

export interface ProjectionStoreContract<TState = unknown> {
  commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult>;

  getDedupeCheckpoint(key: ProjectionDedupeKeyEncoded): Promise<Checkpoint | null>;
}

export interface ProjectionStoreDurableDedupeContract {
  getDedupeCheckpoint(key: ProjectionDedupeKeyEncoded): Promise<Checkpoint | null>;
}

export interface ProjectionStoreAtomicManyContract<TState = unknown> {
  commitAtomicMany(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult>;
}

export interface ProjectionStoreWriteWatermark {
  checkpoint: Checkpoint;
}

/**
 * Optional extension for stores that enforce retention internally.
 *
 * This remains transport/broker agnostic: runtime and adapters may decide
 * whether cleanup is eager, lazy-on-read, or scheduled out-of-band.
 */
export interface ProjectionStoreDedupeRetentionContract {
  setDedupeRetentionPolicy(policy: ProjectionDedupeRetentionPolicy): Promise<void>;
}
