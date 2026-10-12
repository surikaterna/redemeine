import { isCanonicalProjectionUuid, type ProjectionCompleteCommitRangeReader, type ProjectionCompleteCommitRangeRequest } from '@redemeine/projection-runtime-core';
import { createTapewormMongoCompleteCommitRangeReader, type TapewormProjectionCommit } from '@redemeine/projection-transport';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import type { HostConfig } from '../config';
import { assertActive, assertTimeout, closeOnce, connectionFailure, InfrastructureError, retainUntilClosed } from './failure';

export type ExternalConfig = Extract<HostConfig, { mode: 'external' }>;
export type MongoClientFactory = (uri: string, options: MongoClientOptions) => MongoClient;
export function createMongoClient(uri: string, options: MongoClientOptions): MongoClient { return new MongoClient(uri, options); }

function assertRange(request: ProjectionCompleteCommitRangeRequest, config: ExternalConfig): void {
  if (!isCanonicalProjectionUuid(request.sourceId) || !Number.isSafeInteger(request.throughSequence) || request.throughSequence < 0
    || (request.afterSequence !== null && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0 || request.afterSequence >= request.throughSequence))
    || !Number.isSafeInteger(request.maxCommits) || request.maxCommits < 1 || request.maxCommits > config.budget.maxCommits
    || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > config.budget.maxBytes) throw new InfrastructureError('mongo_range_refused');
}

export async function createMongoReader(client: MongoClient, config: ExternalConfig, assertOpen: () => void) {
  const db = client.db(config.external.database); await db.command({ ping: 1 }, { timeoutMS: config.connectTimeoutMs }); assertOpen();
  const indexed = createTapewormMongoCompleteCommitRangeReader({ collection: db.collection<TapewormProjectionCommit>(config.external.collection), partitionId: config.external.partitionId });
  await indexed.initialize(); assertOpen();
  const reader: ProjectionCompleteCommitRangeReader = { capability: indexed.capability, async readCompleteRange(request) {
    assertOpen(); assertRange(request, config);
    try { return await indexed.readCompleteRange(request); } catch { throw new InfrastructureError('mongo_range_refused'); }
  } };
  return reader;
}

export async function openMongoClient(config: ExternalConfig, signal: AbortSignal, factory: MongoClientFactory = createMongoClient) {
  assertActive(signal); assertTimeout(config.connectTimeoutMs); const timeout = config.connectTimeoutMs;
  let client: MongoClient;
  try { client = factory(config.external.mongodbUri, { connectTimeoutMS: timeout, serverSelectionTimeoutMS: timeout, socketTimeoutMS: timeout,
    waitQueueTimeoutMS: timeout, timeoutMS: timeout, maxPoolSize: 4, minPoolSize: 0, readPreference: 'primary', readConcern: { level: 'majority' } }); }
  catch { throw new InfrastructureError('mongo_prerequisite_failed'); }
  let closed = false;
  const close = closeOnce(async () => { try { await client.close(); } catch { throw new InfrastructureError('infrastructure_cleanup_failed'); } });
  const assertOpen = () => { assertActive(signal); if (closed) throw new InfrastructureError('infrastructure_stopped'); };
  try { await client.connect(); assertActive(signal); return { client, assertOpen, close: () => { closed = true; return close(); } }; }
  catch (error) { await retainUntilClosed(close); throw connectionFailure(error, 'mongo_prerequisite_failed'); }
}
