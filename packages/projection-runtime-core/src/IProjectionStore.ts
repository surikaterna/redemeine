import { Checkpoint } from './types';

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
