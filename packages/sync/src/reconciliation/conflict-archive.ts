import type { ConflictRecord } from './conflict-record';

/**
 * Adapter contract for persisting conflict records.
 * Implementation can use any storage — file, database, log sink, etc.
 * This is for ops analysis only; conflict records do not affect
 * application state.
 */
export interface IConflictArchive {
  /** Persists a conflict record for later analysis. */
  archive(record: ConflictRecord): Promise<void>;
}
