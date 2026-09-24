import type { MongoProjectionStoreOptions } from '../src';

// @ts-expect-error transaction execution is adapter-controlled and cannot be overridden.
export type ForbiddenSourceCommitExecutor = MongoProjectionStoreOptions['sourceCommitTransactionExecutor'];
