import { Checkpoint } from './types';

/**
 * Abstract interface for projection state persistence.
 * Any database adapter (MongoDB, PostgreSQL, In-Memory, etc.) must implement this.
 * 
 * CRITICAL: The save() method MUST enforce atomic commit of both:
 * 1. The projection state data
 * 2. The checkpoint cursor (for resumable processing)
 */
export interface IProjectionStore<TState = unknown> {
  /**
   * Load projection state by document ID.
   * @param id The document/projection ID
   * @returns The current state or null if not yet created
   */
  load(id: string): Promise<TState | null>;

  /**
   * Save projection state atomically with its checkpoint.
   * The store must persist both the state and cursor together.
   * 
   * @param id The document/projection ID
   * @param state The updated projection state
   * @param cursor The checkpoint after processing this state
   */
  save(id: string, state: TState, cursor: Checkpoint): Promise<void>;

  /**
   * Check if a document exists (optional method for optimization).
   * Default implementation calls load() and checks for null.
   */
  exists?(id: string): Promise<boolean>;

  /**
   * Delete a projection document (optional, for cleanup scenarios).
   */
  delete?(id: string): Promise<void>;
}
