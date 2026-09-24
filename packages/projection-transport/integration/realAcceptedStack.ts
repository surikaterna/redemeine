import { writeFile } from 'node:fs/promises';
import { connect, type ConfirmChannel } from 'amqplib';
import { type Collection, type Db, MongoClient } from 'mongodb';
import EventStore, { type ICommit } from 'tapeworm';
import MongoTapewormPersistence from 'tapeworm_persistence_store_mongodb';
import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { createTapewormMongoCompleteCommitRangeReader, MongoProjectionTransportStore,
  ProjectionRabbitWorker, SourceTailPoller, type ProjectionTransportDocument,
  type AcceptedBaseline, type TapewormMongoRangeReader } from '../src';
import { adaptChannel, PARTITION_ID, SOURCE_ID, stackDefinitions, stackManifest,
  tapewormCommit, type StackEvent, type StackState } from './realStackFixtures';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
const rabbitUri = required('REDEMEINE_RABBIT_URI').replace('localhost', '127.0.0.1');
const databaseName = `redemeine_accepted_stack_${Date.now()}`;

interface StackContext {
  mongo: MongoClient;
  rabbit: Awaited<ReturnType<typeof connect>>;
  channel: ConfirmChannel;
  db: Db;
  partition: Awaited<ReturnType<InstanceType<typeof EventStore>['openPartition']>>;
  source: Collection<ICommit<StackEvent>>;
  reader: TapewormMongoRangeReader;
  queues: string[];
  failures: string[];
  settlements: string[];
}

function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Bounded real-stack observation timed out.');
}

async function declare(ctx: StackContext, queue: string): Promise<void> {
  await ctx.channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true, arguments: {} });
  await ctx.channel.assertQueue(queue, { durable: true, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed' });
  ctx.queues.push(queue);
}

function record(queue: string, manifest: ReturnType<typeof stackManifest>, b: number): AcceptedBaseline {
  return { version: 2, kind: 'existing', queueBindingId: queue, manifestId: manifest.manifestId,
    registryGeneration: manifest.registryGeneration, sourceId: SOURCE_ID, lastAcceptedSequence: b,
    startAnchor: b + 1, operator: 'real-stack-operator', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'real-stack-operator',
    oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'indexed-source-polling',
    strategyScope: stackDefinitions().map(({ generation, definition }) => ({ projectionName: definition.name,
      generation, strategy: definition.deduplication.strategy, stableSingleTarget: definition.deduplication.strategy === 'in_document' })) };
}

function createWorker(ctx: StackContext, name: string, b: number) {
  const queue = `${databaseName}.${name}`;
  const manifest = stackManifest(queue, 'v1', { [SOURCE_ID]: b + 1 });
  const transport = new MongoProjectionTransportStore({ collection: ctx.db.collection<ProjectionTransportDocument>(`${name}_transport`),
    mongoClient: ctx.mongo, manifest, cutoverReadiness: { reader: ctx.reader } });
  const store = new MongoProjectionStore<StackState>({ collection: ctx.db.collection(`${name}_documents`),
    linkCollection: ctx.db.collection(`${name}_links`), dedupeCollection: ctx.db.collection(`${name}_dedupe`), mongoClient: ctx.mongo });
  const coordinator = createProjectionCommitCoordinator({ queueBindingId: queue, manifest, definitions: stackDefinitions(),
    store, sourceOrder: transport, rangeReader: ctx.reader, maxCommits: 2, maxBytes: 1_048_576, maxGapPages: 5 });
  const tail = new SourceTailPoller({ queueId: queue, sourceIds: [SOURCE_ID], transport, reader: ctx.reader, coordinator,
    maxCommits: 1, maxBytes: 1_048_576, maxPages: 1, intervalMs: 50, onFailure: (error) => ctx.failures.push(error.message) });
  const worker = new ProjectionRabbitWorker({ queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed',
    prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 1_000, coordinator, sourceTail: tail,
    initialize: () => transport.initialize(),
    scheduleRetry: async () => { throw new Error('Unexpected retry publication.'); },
    observeSettlement: ({ kind }) => { ctx.settlements.push(kind); } });
  return { queue, transport, worker, baseline: record(queue, manifest, b), name };
}

async function firstAndLaterUnnotified(ctx: StackContext): Promise<void> {
  const empty = createWorker(ctx, 'empty', -1);
  await declare(ctx, empty.queue);
  await empty.transport.installAcceptedBaseline(empty.baseline);
  assert(await ctx.reader.probeSource(SOURCE_ID, -1) === -1, 'B=-1 did not probe genuine empty source');
  await empty.worker.start(adaptChannel(ctx.channel));
  assert(await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === null, 'Empty source advanced coverage');
  await ctx.partition.append([tapewormCommit(0, [1, 1])]);
  await waitFor(async () => await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === 0);
  const docs = ctx.db.collection<{ _id: string; state: StackState }>('empty_documents');
  assert((await docs.findOne({ _id: 'P:one' }))?.state.count === 2, 'No-arrival seq0 was not applied');
  const zero = createWorker(ctx, 'from_zero', 0);
  await declare(ctx, zero.queue);
  await zero.transport.installAcceptedBaseline(zero.baseline);
  await zero.worker.start(adaptChannel(ctx.channel));
  assert(await zero.transport.loadCoveredThrough(zero.queue, SOURCE_ID) === null, 'H=B must leave coverage empty');
  await ctx.partition.append([tapewormCommit(1, [1])]);
  await waitFor(async () => await zero.transport.loadCoveredThrough(zero.queue, SOURCE_ID) === 1);
  await waitFor(async () => await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === 1);
  const zeroDocs = ctx.db.collection<{ _id: string; state: StackState }>('from_zero_documents');
  assert((await zeroDocs.findOne({ _id: 'P:one' }))?.state.count === 1, 'B=0 later seq1 missing');
  await deliveredDuplicate(ctx, empty.queue, docs);
  await empty.worker.stop();
  await zero.worker.stop();
}

async function deliveredDuplicate(ctx: StackContext, queue: string,
  docs: Collection<{ _id: string; state: StackState }>): Promise<void> {
  const duplicate = tapewormCommit(1, [1]);
  assert(ctx.channel.sendToQueue(queue, Buffer.from(JSON.stringify(duplicate)), { persistent: true, messageId: duplicate.id }),
    'Rabbit duplicate send was rejected');
  await ctx.channel.waitForConfirms();
  await waitFor(async () => ctx.settlements.includes('ack'));
  assert((await docs.findOne({ _id: 'N:one' }))?.state.count === 4, 'none did not repeat delivered redelivery');
  assert((await docs.findOne({ _id: 'P:one' }))?.state.count === 3, 'own record repeated redelivery');
}

async function laterBootstrapAndRestart(ctx: StackContext): Promise<string> {
  await ctx.partition.append([tapewormCommit(2, [1]), tapewormCommit(3, [1])]);
  const nonzero = createWorker(ctx, 'nonzero', 1);
  await declare(ctx, nonzero.queue);
  await nonzero.transport.installAcceptedBaseline(nonzero.baseline);
  await nonzero.worker.start(adaptChannel(ctx.channel));
  assert(await nonzero.transport.loadCoveredThrough(nonzero.queue, SOURCE_ID) === 3, 'B=1 bootstrap did not drain H=3');
  const restarted = createWorker(ctx, 'empty', -1);
  await restarted.worker.start(adaptChannel(ctx.channel));
  assert(await restarted.transport.loadCoveredThrough(restarted.queue, SOURCE_ID) === 3, 'Restart did not drain unnotified tail');
  await restarted.worker.stop();
  await nonzero.worker.stop();
  return restarted.queue;
}

async function rejectTopology(ctx: StackContext, name: string, existing: boolean): Promise<void> {
  const entry = createWorker(ctx, name, -1);
  if (existing) {
    await ctx.channel.assertQueue(entry.queue, { durable: true, deadLetterExchange: 'wrong-dlx' });
    ctx.queues.push(entry.queue);
  }
  const negative = await connect(rabbitUri);
  negative.on('error', () => undefined);
  const channel = await negative.createConfirmChannel();
  channel.on('error', () => undefined);
  let rejected = false;
  try { await entry.worker.start(adaptChannel(channel)); } catch { rejected = true; }
  assert(rejected, `${name}: queue topology did not fail before consume`);
  await negative.close().catch(() => undefined);
}

async function rejectBadHistory(ctx: StackContext): Promise<void> {
  const invalidBirth = createWorker(ctx, 'invalid_birth', -1);
  let birthRejected = false;
  try {
    await invalidBirth.transport.installAcceptedBaseline({ ...invalidBirth.baseline, kind: 'birth' } as unknown as AcceptedBaseline);
  } catch { birthRejected = true; }
  assert(birthRejected && await invalidBirth.transport.readAcceptedBaseline(invalidBirth.queue, SOURCE_ID) === null,
    'Unproven source birth was installed');
  const gapId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await ctx.source.insertMany([
    { ...tapewormCommit(0, [1]), streamId: gapId, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0' },
    { ...tapewormCommit(2, [1]), streamId: gapId, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' }
  ]);
  assert(await ctx.reader.probeSource(gapId, 0) === 2, 'Indexed high watermark failed');
  const page = await ctx.reader.readCompleteRange({ sourceId: gapId, afterSequence: 0, throughSequence: 2,
    maxCommits: 2, maxBytes: 1_048_576 });
  assert(page.status === 'incomplete', 'Missing retained seq1 was treated as an empty tail');
  await ctx.source.deleteOne({ streamId: gapId, commitSequence: 0 });
  let missingB = false;
  try { await ctx.reader.probeSource(gapId, 0); } catch { missingB = true; }
  assert(missingB, 'Missing accepted B was not rejected');
}

async function resourceAbsent(kind: 'queue' | 'exchange', name: string): Promise<boolean> {
  const connection = await connect(rabbitUri);
  connection.on('error', () => undefined);
  const channel = await connection.createChannel();
  channel.on('error', () => undefined);
  try {
    if (kind === 'queue') await channel.checkQueue(name);
    else await channel.checkExchange(name);
    return false;
  } catch {
    return true;
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function finish(ctx: StackContext, queue: string): Promise<void> {
  const probe = await ctx.db.collection<ProjectionTransportDocument>('empty_transport')
    .findOne({ _id: `probe:${queue}:${SOURCE_ID}` });
  assert(probe?.kind === 'source_probe' && probe.observedHighWatermark === 3, 'Probe evidence missing');
  assert(ctx.failures.length === 0 && ctx.settlements.length === 1, 'Unexpected tail failure or Rabbit settlement');
  const indexName = ctx.reader.getIndexName();
  assert(indexName, 'Indexed source query was not available');
  const versions = { mongo: (await ctx.db.admin().command({ buildInfo: 1 })).version,
    rabbit: ctx.rabbit.connection.serverProperties.version, tapeworm: '0.6.0', driver: '6.18.0' };
  for (const name of ctx.queues) {
    await ctx.channel.deleteQueue(name);
    await ctx.channel.deleteExchange(`${name}.dlx`);
  }
  await ctx.db.dropDatabase();
  assert(!(await ctx.mongo.db('admin').admin().listDatabases()).databases.some((entry) => entry.name === databaseName), 'Database cleanup failed');
  for (const name of ctx.queues) {
    assert(await resourceAbsent('queue', name), `Queue cleanup failed: ${name}`);
    assert(await resourceAbsent('exchange', `${name}.dlx`), `DLX cleanup failed: ${name}`);
  }
  await ctx.channel.close(); await ctx.rabbit.close(); await ctx.mongo.close();
  await writeFile(required('REDEMEINE_EVIDENCE_PATH'), JSON.stringify({ gitSha: required('REDEMEINE_GIT_SHA'),
    databaseName, versions, queues: ctx.queues, indexName, probe, failures: ctx.failures, settlements: ctx.settlements,
    missingRejected: true, incompatibleRejected: true, birthRejected: true, missingBoundaryRejected: true,
    gapStatus: 'incomplete', counts: { unnotifiedFirst: 2, duplicateNone: 4, nonzeroBootstrap: 2, restartCoverage: 3 },
    sourceProbeMethod: ctx.reader.getQueryObservation().sourceProbeMethod, logicalCleanupVerified: true }), { flag: 'wx' });
}

async function run(): Promise<void> {
  const mongo = new MongoClient(required('REDEMEINE_MONGO_URI'));
  const rabbit = await connect(rabbitUri);
  const channel = await rabbit.createConfirmChannel();
  await mongo.connect();
  const db = mongo.db(databaseName);
  const partition = await (Reflect.construct(EventStore, [new MongoTapewormPersistence(db)]) as InstanceType<typeof EventStore>)
    .openPartition(PARTITION_ID);
  const source = db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`);
  const reader = createTapewormMongoCompleteCommitRangeReader<StackEvent>({ collection: source, partitionId: PARTITION_ID });
  await reader.initialize();
  const ctx: StackContext = { mongo, rabbit, channel, db, partition, source, reader, queues: [], failures: [], settlements: [] };
  await firstAndLaterUnnotified(ctx);
  const queue = await laterBootstrapAndRestart(ctx);
  await rejectTopology(ctx, 'missing_queue', false);
  await rejectTopology(ctx, 'wrong_topology', true);
  await rejectBadHistory(ctx);
  await finish(ctx, queue);
}

await run();
