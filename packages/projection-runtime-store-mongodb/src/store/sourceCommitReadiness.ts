import type { ClientSession } from 'mongodb';
import type { MongoProjectionStoreOptions } from '../types';
import type { TransactionExecutor } from './transactionExecutor';

export const OWN_PROGRESS_INDEX = 'projection_generation_source_unique';

const hasReadyOwnProgressIndex = (indexes: Array<Record<string, unknown>>): boolean => {
  const index = indexes.find((candidate) => candidate.name === OWN_PROGRESS_INDEX);
  if (!index || index.unique !== true || 'expireAfterSeconds' in index) return false;
  const key = index.key;
  if (!key || typeof key !== 'object' || Array.isArray(key)) return false;
  const fields = Object.keys(key);
  return fields.join(',') === 'projectionName,projectionGeneration,sourceId';
};

const probeTransaction = async <TState>(
  options: MongoProjectionStoreOptions<TState>,
  execute: TransactionExecutor
): Promise<void> => {
  await execute(async (session: ClientSession) => {
    await options.dedupeCollection.findOne({ _id: '__redemeine_v2_readiness__' }, { session });
  });
};

export const ensureSourceCommitStoreReady = async <TState>(
  options: MongoProjectionStoreOptions<TState>,
  execute: TransactionExecutor
): Promise<void> => {
  await options.dedupeCollection.createIndex(
    { projectionName: 1, projectionGeneration: 1, sourceId: 1 },
    {
      name: OWN_PROGRESS_INDEX,
      unique: true,
      partialFilterExpression: {
        projectionName: { $type: 'string' },
        projectionGeneration: { $type: 'string' },
        sourceId: { $type: 'string' }
      }
    }
  );
  const indexes = await options.dedupeCollection.listIndexes().toArray();
  if (!hasReadyOwnProgressIndex(indexes)) {
    throw new Error('projection source commit own-record unique non-TTL index is not ready');
  }
  await probeTransaction(options, execute);
};
