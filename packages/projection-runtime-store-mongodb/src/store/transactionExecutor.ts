import type { ClientSession, MongoServerError, TransactionOptions } from 'mongodb';
import { ProjectionStoreAtomicManyError, createStoreFailure } from '../storeFailures';

const TRANSACTION_NOT_SUPPORTED_CODES = new Set<number>([20, 303, 263]);

const isMongoTransactionError = (error: unknown): error is Error => {
  if (!(error instanceof Error)) {
    return false;
  }

  return ['MongoServerError', 'MongoTransactionError', 'MongoCompatibilityError'].includes(error.name);
};

const isTransactionNotSupportedError = (error: unknown): boolean => {
  if (!isMongoTransactionError(error)) {
    return false;
  }

  const maybeServerError = error as MongoServerError;
  if (typeof maybeServerError.code === 'number' && TRANSACTION_NOT_SUPPORTED_CODES.has(maybeServerError.code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('transaction numbers are only allowed') ||
    message.includes('replica set') ||
    message.includes('does not support transactions') ||
    message.includes('transaction is not supported')
  );
};

const toTransactionUnsupportedError = (): ProjectionStoreAtomicManyError => {
  return new ProjectionStoreAtomicManyError(
    createStoreFailure(
      'terminal',
      'transactions-not-supported',
      'MongoDB transactions are required for atomic projection store operations. Configure a replica set or sharded deployment with transactions enabled.'
    )
  );
};

const runWithTransaction = async <T>(
  session: ClientSession,
  work: (session: ClientSession) => Promise<T>,
  transactionOptions?: TransactionOptions
): Promise<T> => {
  try {
    const result = await session.withTransaction(async () => work(session), transactionOptions);
    return result as T;
  } catch (error) {
    if (isTransactionNotSupportedError(error)) {
      throw toTransactionUnsupportedError();
    }

    throw error;
  }
};

export type TransactionExecutor = <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;

export const createTransactionExecutor = (
  startSession: () => ClientSession,
  transactionOptions?: TransactionOptions
): TransactionExecutor => {
  return async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
    const session = startSession();

    try {
      return await runWithTransaction(session, work, transactionOptions);
    } finally {
      await session.endSession();
    }
  };
};
