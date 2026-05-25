import type { ClientSession } from 'mongodb';
import type { MongoProjectionStoreOptions } from '../types';
import { persistCommitAtomicLinkAndDedupeOps } from './persistCommitAtomicLinkAndDedupeOps';
import { persistCommitAtomicProjectionOps } from './persistCommitAtomicProjectionOps';
import type { CommitAtomicWrite } from './persistCommitAtomicTypes';

export const persistCommitAtomicWithBulkWrite = async <TState>(
  write: CommitAtomicWrite<TState>,
  session: ClientSession,
  options: Pick<MongoProjectionStoreOptions<TState>, 'collection' | 'linkCollection' | 'dedupeCollection'>,
  now: () => string
): Promise<void> => {
  // SAFETY: MongoCollectionLike satisfies the { bulkWrite } structural contract expected by these functions
  await persistCommitAtomicProjectionOps(write, session, options.collection as { bulkWrite: (...args: unknown[]) => Promise<unknown> }, now);
  await persistCommitAtomicLinkAndDedupeOps(write, session, options as { linkCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> }; dedupeCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> } }, now);
};
