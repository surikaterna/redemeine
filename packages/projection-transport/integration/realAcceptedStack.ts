import { writeFile } from 'node:fs/promises';
import { connect, type ConfirmChannel } from 'amqplib';
import { MongoClient } from 'mongodb';
import EventStore, { type ICommit } from 'tapeworm';
import MongoTapewormPersistence from 'tapeworm_persistence_store_mongodb';
import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { createTapewormMongoCompleteCommitRangeReader, MongoProjectionTransportStore,
  ProjectionRabbitWorker, SourceTailPoller, type ProjectionTransportDocument,
  type AcceptedBaseline } from '../src';
import { adaptChannel, PARTITION_ID, SOURCE_ID, stackDefinitions, stackManifest,
  tapewormCommit, type StackEvent, type StackState } from './realStackFixtures';

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
};
const mongoUri = required('REDEMEINE_MONGO_URI');
const rabbitUri = required('REDEMEINE_RABBIT_URI').replace('localhost', '127.0.0.1');
const evidencePath = required('REDEMEINE_EVIDENCE_PATH');
const gitSha = required('REDEMEINE_GIT_SHA');
const databaseName = `redemeine_accepted_stack_${Date.now()}`;
const queueNames: string[] = [];

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

async function declare(channel: ConfirmChannel, queue: string): Promise<void> {
  await channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true, arguments: {} });
  await channel.assertQueue(queue, { durable: true, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed' });
  queueNames.push(queue);
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

async function run(): Promise<void> {
  const mongo = new MongoClient(mongoUri);
  const rabbit = await connect(rabbitUri);
  const channel = await rabbit.createConfirmChannel();
  await mongo.connect();
  const db = mongo.db(databaseName);
  const partition = await (Reflect.construct(EventStore, [new MongoTapewormPersistence(db)]) as InstanceType<typeof EventStore>)
    .openPartition(PARTITION_ID);
  const source = db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`);
  const reader = createTapewormMongoCompleteCommitRangeReader<StackEvent>({ collection: source, partitionId: PARTITION_ID });
  await reader.initialize();
  const failures: string[] = [];
  const settlements: string[] = [];
  const createWorker = (name: string, b: number) => {
    const queue = `${databaseName}.${name}`;
    const manifest = stackManifest(queue, 'v1', { [SOURCE_ID]: b + 1 });
    const transport = new MongoProjectionTransportStore({ collection: db.collection<ProjectionTransportDocument>(`${name}_transport`),
      mongoClient: mongo, manifest, cutoverReadiness: { reader } });
    const store = new MongoProjectionStore<StackState>({ collection: db.collection(`${name}_documents`),
      linkCollection: db.collection(`${name}_links`), dedupeCollection: db.collection(`${name}_dedupe`), mongoClient: mongo });
    const coordinator = createProjectionCommitCoordinator({ queueBindingId: queue, manifest, definitions: stackDefinitions(),
      store, sourceOrder: transport, rangeReader: reader, maxCommits: 2, maxBytes: 1_048_576, maxGapPages: 5 });
    const tail = new SourceTailPoller({ queueId: queue, sourceIds: [SOURCE_ID], transport, reader, coordinator,
      maxCommits: 1, maxBytes: 1_048_576, maxPages: 1, intervalMs: 50, onFailure: (error) => failures.push(error.message) });
    const worker = new ProjectionRabbitWorker({ queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed',
      prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 1_000, coordinator, sourceTail: tail,
      initialize: () => transport.initialize(),
      scheduleRetry: async () => { throw new Error('Unexpected retry publication.'); },
      observeSettlement: ({ kind }) => { settlements.push(kind); } });
    return { queue, manifest, transport, worker, tail, record: record(queue, manifest, b), name };
  };

  const empty = createWorker('empty', -1);
  await declare(channel, empty.queue);
  await empty.transport.installAcceptedBaseline(empty.record);
  assert(await reader.probeSource(SOURCE_ID, -1) === -1, 'B=-1 did not probe genuine empty source');
  await empty.worker.start(adaptChannel(channel));
  assert(await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === null, 'Empty source advanced coverage');
  await partition.append([tapewormCommit(0, [1, 1])]);
  await waitFor(async () => await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === 0);
  const emptyDocuments = db.collection<{ _id: string; state: StackState }>('empty_documents');
  assert((await emptyDocuments.findOne({ _id: 'P:one' }))?.state.count === 2, 'No-arrival seq0 was not applied');

  const fromZero = createWorker('from_zero', 0);
  await declare(channel, fromZero.queue);
  await fromZero.transport.installAcceptedBaseline(fromZero.record);
  await fromZero.worker.start(adaptChannel(channel));
  assert(await fromZero.transport.loadCoveredThrough(fromZero.queue, SOURCE_ID) === null, 'H=B must leave coverage empty');
  await partition.append([tapewormCommit(1, [1])]);
  await waitFor(async () => await fromZero.transport.loadCoveredThrough(fromZero.queue, SOURCE_ID) === 1);
  await waitFor(async () => await empty.transport.loadCoveredThrough(empty.queue, SOURCE_ID) === 1);
  const zeroDocuments = db.collection<{ _id: string; state: StackState }>('from_zero_documents');
  assert((await zeroDocuments.findOne({ _id: 'P:one' }))?.state.count === 1, 'B=0 later seq1 missing');

  const duplicate = tapewormCommit(1, [1]);
  assert(channel.sendToQueue(empty.queue, Buffer.from(JSON.stringify(duplicate)), { persistent: true, messageId: duplicate.id }),
    'Rabbit duplicate send was rejected');
  await channel.waitForConfirms();
  await waitFor(async () => settlements.includes('ack'));
  assert((await emptyDocuments.findOne({ _id: 'N:one' }))?.state.count === 4, 'none did not repeat delivered redelivery');
  assert((await emptyDocuments.findOne({ _id: 'P:one' }))?.state.count === 3, 'own record repeated redelivery');
  await empty.worker.stop();
  await fromZero.worker.stop();

  await partition.append([tapewormCommit(2, [1]), tapewormCommit(3, [1])]);
  const nonzero = createWorker('nonzero', 1);
  await declare(channel, nonzero.queue);
  await nonzero.transport.installAcceptedBaseline(nonzero.record);
  await nonzero.worker.start(adaptChannel(channel));
  assert(await nonzero.transport.loadCoveredThrough(nonzero.queue, SOURCE_ID) === 3, 'B=1 bootstrap did not drain H=3');
  const restarted = createWorker('empty', -1);
  await restarted.worker.start(adaptChannel(channel));
  assert(await restarted.transport.loadCoveredThrough(restarted.queue, SOURCE_ID) === 3, 'Restart did not drain unnotified tail');
  await restarted.worker.stop();
  await nonzero.worker.stop();

  const missing = createWorker('missing_queue', -1);
  const missingRabbit = await connect(rabbitUri);
  missingRabbit.on('error', () => undefined);
  const missingChannel = await missingRabbit.createConfirmChannel();
  missingChannel.on('error', () => undefined);
  let missingRejected = false;
  try { await missing.worker.start(adaptChannel(missingChannel)); } catch { missingRejected = true; }
  assert(missingRejected, 'Missing Rabbit queue did not fail before consume');
  await missingRabbit.close().catch(() => undefined);
  const wrong = createWorker('wrong_topology', -1);
  await channel.assertQueue(wrong.queue, { durable: true, deadLetterExchange: 'wrong-dlx' });
  queueNames.push(wrong.queue);
  const wrongRabbit = await connect(rabbitUri);
  wrongRabbit.on('error', () => undefined);
  const wrongChannel = await wrongRabbit.createConfirmChannel();
  wrongChannel.on('error', () => undefined);
  let incompatibleRejected = false;
  try { await wrong.worker.start(adaptChannel(wrongChannel)); } catch { incompatibleRejected = true; }
  assert(incompatibleRejected, 'Incompatible queue/DLX topology did not fail');
  await wrongRabbit.close().catch(() => undefined);
  assert(settlements.length === 1, 'Negative topology checks settled a delivery');
  const invalidBirth = createWorker('invalid_birth', -1);
  let birthRejected = false;
  try {
    await invalidBirth.transport.installAcceptedBaseline({ ...invalidBirth.record, kind: 'birth' } as unknown as AcceptedBaseline);
  } catch { birthRejected = true; }
  assert(birthRejected && await invalidBirth.transport.readAcceptedBaseline(invalidBirth.queue, SOURCE_ID) === null,
    'Unproven source birth was installed');

  const gapId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const gapZero = { ...tapewormCommit(0, [1]), streamId: gapId, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0' };
  const gapTwo = { ...tapewormCommit(2, [1]), streamId: gapId, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' };
  await source.insertMany([gapZero, gapTwo]);
  assert(await reader.probeSource(gapId, 0) === 2, 'Indexed high watermark failed');
  const missingPage = await reader.readCompleteRange({ sourceId: gapId, afterSequence: 0, throughSequence: 2,
    maxCommits: 2, maxBytes: 1_048_576 });
  assert(missingPage.status === 'incomplete', 'Missing retained seq1 was treated as an empty tail');
  await source.deleteOne({ streamId: gapId, commitSequence: 0 });
  let missingBoundaryRejected = false;
  try { await reader.probeSource(gapId, 0); } catch { missingBoundaryRejected = true; }
  assert(missingBoundaryRejected, 'Missing accepted B was not rejected');

  const indexName = reader.getIndexName();
  const probe = await db.collection<ProjectionTransportDocument>('empty_transport').findOne({ _id: `probe:${empty.queue}:${SOURCE_ID}` });
  assert(indexName && probe?.kind === 'source_probe' && probe.observedHighWatermark === 3, 'Probe evidence missing');
  assert(failures.length === 0, `Source polling failures: ${failures.join('; ')}`);
  const versions = { mongo: (await db.admin().command({ buildInfo: 1 })).version,
    rabbit: rabbit.connection.serverProperties.version, tapeworm: '0.6.0', driver: '6.18.0' };
  for (const queue of queueNames) {
    await channel.deleteQueue(queue);
    await channel.deleteExchange(`${queue}.dlx`);
  }
  await db.dropDatabase();
  assert(!(await mongo.db('admin').admin().listDatabases()).databases.some((entry) => entry.name === databaseName), 'Database cleanup failed');
  await channel.close(); await rabbit.close(); await mongo.close();
  await writeFile(evidencePath, JSON.stringify({ gitSha, databaseName, versions, queues: queueNames, indexName,
    sourceProbeMethod: reader.getQueryObservation().sourceProbeMethod, counts: { unnotifiedFirst: 2, duplicateNone: 4,
      nonzeroBootstrap: 2, restartCoverage: 3 }, probe, failures, settlements,
    missingRejected, incompatibleRejected, birthRejected, missingBoundaryRejected,
    gapStatus: missingPage.status, logicalCleanupVerified: true }), { flag: 'wx' });
}

await run();
