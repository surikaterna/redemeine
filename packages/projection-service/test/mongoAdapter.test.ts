import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import type { MongoClient } from 'mongodb';
import { openMongoPrerequisites } from '../src/infrastructure/mongo';
import { mongoFixtureNamespace } from '../src/infrastructure/mongoFixtures';
import { builtArtifact } from './fixtures';
import { deferred, until } from './support/deferred';
import { mongoClientFixture, mongoRangeFixture } from './support/mongoClient';

afterEach(() => { jest.restoreAllMocks(); });

test('actual Mongo factory uses bounded options, read-only prerequisites, isolated uninitialized fixture stores', async () => {
  const f = mongoClientFixture();
  const artifact = await builtArtifact();
  const mongo = await openMongoPrerequisites(f.config, artifact, new AbortController().signal, f.factory);
  expect(f.factory).toHaveBeenCalledWith(f.config.external.mongodbUri, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 5000, waitQueueTimeoutMS: 5000, timeoutMS: 5000, maxPoolSize: 4, minPoolSize: 0,
    readPreference: 'primary', readConcern: { level: 'majority' } });
  expect(f.instances[0]?.options.serverSelectionTimeoutMS).toBe(5000);
  expect(f.ping).toHaveBeenCalledWith({ ping: 1 }, { timeoutMS: 5000 });
  expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
  expect(f.endSession).toHaveBeenCalledTimes(1);
  expect(f.findOne).toHaveBeenCalledWith({ _id: '__redemeine_v2_readiness__' }, expect.objectContaining({ maxTimeMS: 5000 }));
  expect(mongo.uninitializedStores.map((entry) => entry.projectionName)).toEqual(['model:inline-counter', 'model:own-counter']);
  expect(mongo.uninitializedStores.every((entry) => entry.store instanceof MongoProjectionStore)).toBe(true);
  expect(mongoFixtureNamespace(artifact)).toContain(artifact.registryDigest);
  const namespace = mongoFixtureNamespace(artifact);
  expect(f.collections.mock.calls.map(([name]) => name)).toEqual(['commits', `${namespace}_0_dedupe`, `${namespace}_floors`,
    `${namespace}_0_documents`, `${namespace}_0_links`, `${namespace}_0_dedupe`,
    `${namespace}_1_documents`, `${namespace}_1_links`, `${namespace}_1_dedupe`]);
  expect(f.initialize).not.toHaveBeenCalled();
  expect(f.createIndex).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  await mongo.close(); await mongo.close();
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('real indexed whole-commit reader uses bounded source range only, floor loads are majority point reads', async () => {
  const f = mongoClientFixture();
  const range = mongoRangeFixture(f.seed);
  const mongo = await openMongoPrerequisites(f.config, await builtArtifact(), new AbortController().signal, f.factory);
  const request = { sourceId: range.row.streamId, afterSequence: 41, throughSequence: 42, maxCommits: 1, maxBytes: 10000 };
  expect(await mongo.reader.readCompleteRange(request)).toMatchObject({ status: 'complete', commits: [{ commit: { commitSequence: 42 } }] });
  expect(range.find).toHaveBeenCalledWith({ streamId: request.sourceId, commitSequence: { $gt: 41, $lte: 42 } });
  expect(range.sort).toHaveBeenCalledWith({ commitSequence: 1 });
  expect(range.hint).toHaveBeenCalledWith('stream_sequence');
  expect(range.limit).toHaveBeenCalledWith(2);
  expect(range.batchSize).toHaveBeenCalledWith(1);
  expect('probeSource' in mongo.reader).toBe(false);
  await mongo.sourceOrder.load(request.sourceId, 'candidate:epoch');
  expect(f.findOne).toHaveBeenLastCalledWith({ _id: JSON.stringify(['candidate:epoch', request.sourceId]) }, { readConcern: { level: 'majority' } });
  await expect(mongo.reader.readCompleteRange({ ...request, maxCommits: 0 })).rejects.toThrow('mongo_range_refused');
  await mongo.close();
  await expect(mongo.reader.readCompleteRange(request)).rejects.toThrow('infrastructure_stopped');
});

test.each(['missing_index', 'nonunique_index', 'partial_index', 'transaction', 'connect'])('%s refuses prerequisite completion without dispatch or DDL', async (fault) => {
  const f = mongoClientFixture();
  if (fault === 'missing_index') f.indexRows.mockResolvedValue([]);
  if (fault === 'nonunique_index') f.indexRows.mockResolvedValue([{ name: 'bad', key: { streamId: 1, commitSequence: 1 }, unique: false }]);
  if (fault === 'partial_index') f.indexRows.mockResolvedValue([{ name: 'bad', key: { streamId: 1, commitSequence: 1 }, unique: true, partialFilterExpression: { secret: true } }]);
  if (fault === 'transaction') f.transaction.mockRejectedValue(new Error('secret-canary transaction failed'));
  if (fault === 'connect') f.connect.mockRejectedValue(new Error('mongodb://secret-canary'));
  await expect(openMongoPrerequisites(f.config, await builtArtifact(), new AbortController().signal, f.factory)).rejects.toThrow('mongo_prerequisite_failed');
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.createIndex).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled();
});

test('late Mongo connect after cancellation joins close, and never initializes stores or reads metadata', async () => {
  const f = mongoClientFixture();
  const pending = deferred<void>();
  f.connect.mockImplementation(async function(this: MongoClient) { await pending.promise; return this; });
  const controller = new AbortController();
  const opening = openMongoPrerequisites(f.config, await builtArtifact(), controller.signal, f.factory);
  const result = opening.catch((error: unknown) => error);
  controller.abort(); pending.resolve();
  expect(await result).toMatchObject({ message: 'mongo_prerequisite_failed' });
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.ping).not.toHaveBeenCalled();
});

test('unresolved partial Mongo cleanup does not report acquisition failed/drained early', async () => {
  const f = mongoClientFixture();
  const cleanup = deferred<void>();
  f.connect.mockRejectedValue(new Error('secret-canary'));
  f.close.mockReturnValue(cleanup.promise);
  let settled = false;
  const opening = openMongoPrerequisites(f.config, await builtArtifact(), new AbortController().signal, f.factory)
    .catch(() => { settled = true; });
  await until(() => f.close.mock.calls.length === 1);
  expect(settled).toBe(false);
  cleanup.resolve(); await opening;
  expect(settled).toBe(true);
});
