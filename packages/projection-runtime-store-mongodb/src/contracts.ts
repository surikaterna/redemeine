import type {
  Checkpoint as CoreCheckpoint,
  ProjectionStoreAtomicManyCommittedResult as CoreProjectionStoreAtomicManyCommittedResult,
  ProjectionStoreAtomicManyRejectedResult as CoreProjectionStoreAtomicManyRejectedResult,
  ProjectionStoreAtomicManyResult as CoreProjectionStoreAtomicManyResult,
  ProjectionStoreRfc6902Operation as CoreProjectionStoreRfc6902Operation,
  ProjectionStoreFailureCategory as CoreProjectionStoreFailureCategory,
  ProjectionStoreWriteFailure as CoreProjectionStoreWriteFailure,
  ProjectionStoreWritePrecondition as CoreProjectionStoreWritePrecondition,
  ProjectionStoreFullDocumentWrite as CoreProjectionStoreFullDocumentWrite,
  ProjectionStorePatchDocumentWrite as CoreProjectionStorePatchDocumentWrite,
  ProjectionStoreDocumentWrite as CoreProjectionStoreDocumentWrite,
  ProjectionStoreDedupeWrite as CoreProjectionStoreDedupeWrite,
  ProjectionStoreAtomicWrite as CoreProjectionStoreAtomicWrite,
  ProjectionStoreCommitAtomicManyRequest as CoreProjectionStoreCommitAtomicManyRequest
} from '@redemeine/projection-runtime-core';

export type Checkpoint = CoreCheckpoint;

export interface ProjectionDedupeWrite {
  upserts: Array<{ key: string; checkpoint: Checkpoint }>;
}

export interface ProjectionAtomicWrite<TState> {
  documents: Array<{ documentId: string; state: TState; checkpoint: Checkpoint }>;
  links: Array<{ aggregateType: string; aggregateId: string; targetDocId: string }>;
  cursorKey: string;
  cursor: Checkpoint;
  dedupe: ProjectionDedupeWrite;
}

export interface IProjectionStore<TState = unknown> {
  load(documentId: string): Promise<TState | null>;
  save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void>;
  commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void>;
  commitAtomicMany?(
    request: ProjectionStoreCommitAtomicManyRequest<TState>
  ): Promise<ProjectionStoreAtomicManyResult>;
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null>;
  getCheckpoint?(key: string): Promise<Checkpoint | null>;
  getDedupeCheckpoint(key: string): Promise<Checkpoint | null>;
  delete?(documentId: string): Promise<void>;
}

export type ProjectionStoreAtomicManyCommittedResult = CoreProjectionStoreAtomicManyCommittedResult;
export type ProjectionStoreAtomicManyRejectedResult = CoreProjectionStoreAtomicManyRejectedResult;
export type ProjectionStoreAtomicManyResult = CoreProjectionStoreAtomicManyResult;
export type ProjectionStoreRfc6902Operation = CoreProjectionStoreRfc6902Operation;
export type ProjectionStoreFailureCategory = CoreProjectionStoreFailureCategory;
export type ProjectionStoreWriteFailure = CoreProjectionStoreWriteFailure;
export type ProjectionStoreWritePrecondition = CoreProjectionStoreWritePrecondition;
export type ProjectionStoreFullDocumentWrite<TState = unknown> = CoreProjectionStoreFullDocumentWrite<TState>;
export type ProjectionStorePatchDocumentWrite = CoreProjectionStorePatchDocumentWrite;
export type ProjectionStoreDocumentWrite<TState = unknown> = CoreProjectionStoreDocumentWrite<TState>;
export type ProjectionStoreDedupeWrite = CoreProjectionStoreDedupeWrite;
export type ProjectionStoreAtomicWrite<TState = unknown> = CoreProjectionStoreAtomicWrite<TState>;
export type ProjectionStoreCommitAtomicManyRequest<TState = unknown> = CoreProjectionStoreCommitAtomicManyRequest<TState>;

export interface IProjectionLinkStore {
  addLink(aggregateType: string, aggregateId: string, targetDocId: string): Promise<void> | void;
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> | string | null;
  removeLinksForTarget?(targetDocId: string): Promise<void> | void;
}
