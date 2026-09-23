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
  await persistCommitAtomicProjectionOps(write, session, options.collection, now);
  await persistCommitAtomicLinkAndDedupeOps(write, session, options, now);
};
