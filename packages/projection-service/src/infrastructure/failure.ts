export type InfrastructureReason = 'mongo_prerequisite_failed' | 'rabbit_prerequisite_failed' | 'infrastructure_stopped'
  | 'invalid_infrastructure_budget' | 'rabbit_ack_refused' | 'mongo_range_refused' | 'infrastructure_cleanup_failed';

export class InfrastructureError extends Error {
  constructor(readonly reason: InfrastructureReason) { super(reason); }
}

export function connectionFailure(error: unknown, reason: InfrastructureReason): Error {
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) return new TransientConnectionError();
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error.code)) return new TransientConnectionError();
  return new InfrastructureError(reason);
}

export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new InfrastructureError('infrastructure_stopped');
}

export function assertTimeout(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60000) {
    throw new InfrastructureError('invalid_infrastructure_budget');
  }
}

/** A failed partial acquisition cannot look drained while its cleanup is uncertain. */
export async function retainUntilClosed(close: () => Promise<void>): Promise<void> {
  try { await close(); } catch { await new Promise<void>(() => {}); }
}

export function closeOnce(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => { closing ??= Promise.resolve().then(close); return closing; };
}

export async function closeResources(operations: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(operations.map((close) => Promise.resolve().then(close)));
  if (results.some((result) => result.status === 'rejected')) throw new InfrastructureError('infrastructure_cleanup_failed');
}
import { MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import { TransientConnectionError } from '../reconnect';
