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
  reason: string;
  committedCount: 0;
}

export type ProjectionStoreAtomicManyResult =
  | ProjectionStoreAtomicManyCommittedResult
  | ProjectionStoreAtomicManyRejectedResult;

export type ProjectionDocumentWriteMode = 'full' | 'patch';

export interface ProjectionStoreFullDocumentWrite<TState = unknown> {
  documentId: string;
  mode: 'full';
  fullDocument: TState;
  checkpoint: Checkpoint;
}

export interface ProjectionStorePatchDocumentWrite {
  documentId: string;
  mode: 'patch';
  patch: Record<string, unknown>;
  checkpoint: Checkpoint;
}

export type ProjectionStoreDocumentWrite<TState = unknown> =
  | ProjectionStoreFullDocumentWrite<TState>
  | ProjectionStorePatchDocumentWrite;

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
