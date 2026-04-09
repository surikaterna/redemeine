import { Checkpoint } from './types';

export interface ProjectionDocumentWrite<TState> {
  documentId: string;
  state: TState;
  checkpoint: Checkpoint;
}

export interface ProjectionLinkAddWrite {
  op: 'add';
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
}

export interface ProjectionLinkRemoveWrite {
  op: 'remove';
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
}

export type ProjectionLinkWrite = ProjectionLinkAddWrite | ProjectionLinkRemoveWrite;

/**
 * E4.2 contract stub for durable dedupe persistence.
 *
 * Runtime-core E4.1 can pass this through without semantics.
 */
export interface ProjectionDedupeWrite {
  upserts: Array<{ key: string; checkpoint: Checkpoint }>;
}

export interface ProjectionAtomicWrite<TState> {
  documents: ProjectionDocumentWrite<TState>[];
  links: ProjectionLinkWrite[];
  cursorKey: string;
  cursor: Checkpoint;
  dedupe?: ProjectionDedupeWrite;
}

/**
 * Interface for storing and retrieving projection state
 */
export interface IProjectionStore<TState = unknown> {
  /**
   * Load the current state for a projection document
   * @param documentId The document ID to load
   * @returns The current state or null if not found
   */
  load(documentId: string): Promise<TState | null>;

  /**
   * Save the projection state atomically
   * @param documentId The document ID to save
   * @param state The state to save
   * @param checkpoint The checkpoint for this state
   */
  save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void>;

  /**
   * Commit projection writes as one atomic unit.
   *
   * This is the required production write path for runtime-core execution.
   */
  commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void>;

  /**
   * Resolve a joined aggregate to its target projection document.
   */
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null>;

  /**
   * Get a checkpoint for a specific key
   * @param key The checkpoint key
   */
  getCheckpoint?(key: string): Promise<Checkpoint | null>;

  /**
   * Delete a projection document
   * @param documentId The document ID to delete
   */
  delete?(documentId: string): Promise<void>;
}
