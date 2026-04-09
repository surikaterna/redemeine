/**
 * Local copy of the current projection runtime store contracts.
 *
 * This keeps the Mongo adapter package buildable in isolation while the
 * runtime-core package split is still in progress.
 */
export interface Checkpoint {
  sequence: number;
  timestamp?: string;
}

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

export interface IProjectionLinkStore {
  addLink(aggregateType: string, aggregateId: string, targetDocId: string): Promise<void> | void;
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> | string | null;
  removeLinksForTarget?(targetDocId: string): Promise<void> | void;
}
