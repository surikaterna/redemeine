import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { connect, type ConfirmChannel } from 'amqplib';
import { MongoClient, type Collection } from 'mongodb';
import EventStore, { type ICommit } from 'tapeworm';
import MongoTapewormPersistence from 'tapeworm_persistence_store_mongodb';
import { awaitStackChild, type ChildOutcome } from './childRunner';
import {
  MongoProjectionTransportStore,
  type ProjectionTransportDocument
} from '../src';
import {
  PARTITION_ID,
  SOURCE_ID,
  stackManifest,
  tapewormCommit,
  type StackEvent,
  type StackState
} from './realStackFixtures';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const mongoUri = required('REDEMEINE_MONGO_URI');
const rabbitUri = required('REDEMEINE_RABBIT_URI').replace('localhost', '127.0.0.1');
const evidencePath = required('REDEMEINE_EVIDENCE_PATH');
const gitSha = required('REDEMEINE_GIT_SHA');
const databaseName = `redemeine_projection_transport_${Date.now()}`;
const queues: string[] = [];
const childRuns: ChildOutcome[] = [];
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function declareTopology(channel: ConfirmChannel, queue: string): Promise<void> {
  await channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true, arguments: {} });
  await channel.assertQueue(`${queue}.dead`, { durable: true });
  await channel.bindQueue(`${queue}.dead`, `${queue}.dlx`, 'failed');
  await channel.assertQueue(`${queue}.retry`, {
    durable: true,
    deadLetterExchange: '',
    deadLetterRoutingKey: queue
  });
  await channel.assertQueue(queue, {
    durable: true,
    deadLetterExchange: `${queue}.dlx`,
    deadLetterRoutingKey: 'failed'
  });
}

async function runChild(
  scenario: string,
  queue: string,
  expectedSettlement: string,
  crashPoint = ''
): Promise<ChildOutcome> {
  const child = spawn(process.execPath, [tsxCli, 'integration/realStackChild.ts'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['inherit', 'inherit', 'pipe'],
    env: {
      ...process.env,
      REDEMEINE_MONGO_URI: mongoUri,
      REDEMEINE_RABBIT_URI: rabbitUri,
      REDEMEINE_DATABASE: databaseName,
      REDEMEINE_QUEUE: queue,
      REDEMEINE_SCENARIO: scenario,
      REDEMEINE_EXPECTED_SETTLEMENT: expectedSettlement,
      ...(crashPoint ? { REDEMEINE_CRASH_POINT: crashPoint } : {})
    }
  });
  const outcome = await awaitStackChild(child, scenario, 45_000);
  childRuns.push(outcome);
  return outcome;
}

async function publish(channel: ConfirmChannel, queue: string, body: unknown, messageId: string): Promise<void> {
  const accepted = channel.sendToQueue(queue, Buffer.from(JSON.stringify(body)), { persistent: true, messageId });
  assert(accepted, `Rabbit write buffer rejected ${queue}.`);
  await channel.waitForConfirms();
}

async function scenarioCollections(client: MongoClient, scenario: string) {
  const db = client.db(databaseName);
  return {
    documents: db.collection<{ _id: string; state: StackState }>(`${scenario}_documents`),
    links: db.collection(`${scenario}_links`),
    dedupe: db.collection(`${scenario}_dedupe`),
    transport: db.collection<ProjectionTransportDocument>(`${scenario}_transport`),
    attempts: db.collection('definitionAttempts'),
    barriers: db.collection('crashBarriers'),
    settlements: db.collection('settlements')
  };
}

async function assertProjectionState(client: MongoClient, scenario: string, expectedN: number, coverage: number): Promise<void> {
  const stores = await scenarioCollections(client, scenario);
  const [p, n, q, cursor, ownNoTarget] = await Promise.all([
    stores.documents.findOne({ _id: 'P:one' }),
    stores.documents.findOne({ _id: 'N:one' }),
    stores.documents.findOne({ _id: 'Q:one' }),
    stores.transport.findOne({ kind: 'coverage', sourceId: SOURCE_ID }),
    stores.dedupe.findOne({ projectionName: 'O-own-no-target', sourceId: SOURCE_ID })
  ]);
  assert(p?.state.count === coverage + 2, `${scenario}: P state mismatch.`);
  assert(q?.state.count === coverage + 2, `${scenario}: Q state mismatch.`);
  assert(n?.state.count === expectedN, `${scenario}: N state mismatch.`);
  assert(cursor?.kind === 'coverage' && cursor.sequence === coverage, `${scenario}: coverage mismatch.`);
  assert(ownNoTarget?.commitSequence === coverage, `${scenario}: own no-target progress missing.`);
  assert(await stores.links.countDocuments() === 2, `${scenario}: staged projection links missing.`);
}

async function runCrashScenario(
  client: MongoClient,
  channel: ConfirmChannel,
  wire: ICommit<StackEvent>,
  point: string,
  expectedN: number
): Promise<Record<string, unknown>> {
  const scenario = `crash_${point}`;
  const queue = `${databaseName}.${scenario}`;
  queues.push(queue);
  await declareTopology(channel, queue);
  await publish(channel, queue, wire, wire.id);
  const crashed = await runChild(scenario, queue, 'ack', point);
  const killed = crashed.signal === 'SIGKILL' || crashed.code === 128 + 9;
  assert(killed, `${point}: child did not terminate at the barrier.`);
  const stores = await scenarioCollections(client, scenario);
  const barrier = await stores.barriers.findOne({ scenario, point });
  assert(barrier !== null, `${point}: durable crash barrier missing.`);
  if (point === 'before_save') {
    assert(await stores.documents.countDocuments() === 0, 'before_save leaked state.');
    assert(await stores.links.countDocuments() === 0, 'before_save leaked links.');
    assert(await stores.dedupe.countDocuments() === 0, 'before_save leaked progress.');
  }
  if (point === 'after_p') {
    assert(await stores.documents.countDocuments() === 1, 'after_p did not isolate first definition.');
    assert(await stores.links.countDocuments() === 1, 'after_p did not isolate first definition links.');
  }
  if (point === 'after_all') {
    assert(await stores.transport.countDocuments({ kind: 'coverage' }) === 1, 'after_all admission metadata missing.');
    const row = await stores.transport.findOne({ kind: 'coverage' });
    assert(row?.kind === 'coverage' && row.sequence === null, 'after_all advanced coverage before all completion returned.');
  }
  if (point === 'after_coverage') {
    const row = await stores.transport.findOne({ kind: 'coverage' });
    assert(row?.kind === 'coverage' && row.sequence === 0, 'after_coverage barrier did not persist coverage.');
  }
  const restarted = await runChild(scenario, queue, 'ack');
  assert(restarted.code === 0, `${point}: restart did not ACK.`);
  await assertProjectionState(client, scenario, expectedN, 0);
  const attempts = await stores.attempts.find({ scenario }).toArray();
  const counts = Object.fromEntries(['P-own', 'N-none', 'Q-inline', 'O-own-no-target'].map((name) => [
    name, attempts.filter((entry) => entry.projection === name).length
  ]));
  return { point, counts, redelivered: true };
}

async function runNormalSequenceZero(
  client: MongoClient,
  channel: ConfirmChannel,
  wire: ICommit<StackEvent>
): Promise<Record<string, unknown>> {
  const scenario = 'normal_seq0';
  const queue = `${databaseName}.${scenario}`;
  queues.push(queue);
  await declareTopology(channel, queue);
  await publish(channel, queue, wire, wire.id);
  assert((await runChild(scenario, queue, 'ack')).code === 0, 'Normal sequence-zero child failed.');
  await assertProjectionState(client, scenario, 4, 0);
  return { sequence: 0, events: wire.events.length, acknowledged: true };
}

async function runGapAndReconnect(client: MongoClient, channel: ConfirmChannel, commits: readonly ICommit<StackEvent>[]) {
  const scenario = 'gap_reconnect';
  const queue = `${databaseName}.${scenario}`;
  queues.push(queue);
  await declareTopology(channel, queue);
  await publish(channel, queue, commits[1], commits[1]?.id ?? 'missing');
  assert((await runChild(scenario, queue, 'ack')).code === 0, 'Gap catchup child failed.');
  await assertProjectionState(client, scenario, 4, 1);
  await publish(channel, queue, commits[1], commits[1]?.id ?? 'missing');
  assert((await runChild(scenario, queue, 'ack')).code === 0, 'Reconnect redelivery failed.');
  await assertProjectionState(client, scenario, 5, 1);
  return { recoveredSequences: [0, 1], reconnectRedelivery: true, noneCount: 5 };
}

async function runPoisonAndRetry(client: MongoClient, channel: ConfirmChannel): Promise<Record<string, unknown>> {
  const terminalQueue = `${databaseName}.terminal`;
  queues.push(terminalQueue);
  await declareTopology(channel, terminalQueue);
  await publish(channel, terminalQueue, '{', 'bad-message');
  assert((await runChild('terminal', terminalQueue, 'permanent')).code === 0, 'Terminal child failed.');
  const dead = await channel.get(`${terminalQueue}.dead`, { noAck: true });
  assert(dead !== false, 'Permanent poison did not reach DLQ.');

  const retryQueue = `${databaseName}.retry`;
  queues.push(retryQueue);
  await declareTopology(channel, retryQueue);
  // The source is configured, but commit 2 has not been persisted: this is a transient indexed-tail miss.
  const missing = tapewormCommit(2, [1]);
  await publish(channel, retryQueue, missing, missing.id);
  assert((await runChild('retry', retryQueue, 'retry')).code === 0, 'Retry child failed.');
  const retryDepth = (await channel.checkQueue(`${retryQueue}.retry`)).messageCount;
  assert(retryDepth === 1, 'Durable retry queue did not retain the delayed message.');
  const db = client.db(databaseName);
  const publication = await db.collection('retryPublications').findOne({ scenario: 'retry' });
  const settlement = await db.collection('settlements').findOne({ scenario: 'retry', kind: 'retry' });
  assert((await db.collection('settlements').countDocuments({ scenario: 'retry', kind: 'retry' })) === 1,
    'Retry delivery was NACKed more than once.');
  assert((await db.collection('retryPublications').countDocuments({ scenario: 'retry' })) === 1,
    'Retry publisher was invoked more than once.');
  assert(typeof settlement?.reason === 'string' && settlement.reason.includes('beyond the indexed source tail'),
    'Retry was not caused by a missing indexed commit on the configured source.');
  assert(publication?.topologyVerified === true, 'Retry topology was not verified by the publisher.');
  assert(publication.persistent === true && publication.mandatory === true, 'Retry publication flags missing.');
  assert(publication.confirmCount === 1 && publication.returnedCount === 0, 'Retry confirmation evidence invalid.');
  assert(publication.confirmedAt instanceof Date, 'Retry confirmation timestamp missing.');
  assert(settlement?.observedAt instanceof Date, 'Retry NACK settlement timestamp missing.');
  assert(publication.confirmedAt <= settlement.observedAt, 'Worker NACK preceded retry confirmation.');
  const unknownSource = await runUnknownSourceRetry(client, channel);
  return {
    terminalDlq: true, durableRetryDepth: retryDepth, backoffMs: 60_000, unknownSource,
    retryPublisher: {
      persistent: true, mandatory: true, topologyVerified: true,
      confirmCount: publication.confirmCount, returnedCount: publication.returnedCount,
      backpressureWaitCount: publication.backpressureWaitCount,
      confirmedAt: publication.confirmedAt, nackObservedAt: settlement.observedAt
    }
  };
}

async function runUnknownSourceRetry(client: MongoClient, channel: ConfirmChannel): Promise<Record<string, unknown>> {
  const scenario = 'unknown_source';
  const queue = `${databaseName}.${scenario}`;
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  queues.push(queue);
  await declareTopology(channel, queue);
  const unknown = { ...tapewormCommit(1, [1]), streamId: sourceId };
  await publish(channel, queue, unknown, unknown.id);
  assert((await runChild(scenario, queue, 'retry')).code === 0, 'Unknown-source child failed.');
  const stores = await scenarioCollections(client, scenario);
  const settlement = await stores.settlements.findOne({ scenario, kind: 'retry' });
  assert(settlement?.reason === 'Unconfigured Rabbit source UUID.', 'Unknown source was not explicitly rejected.');
  assert(await stores.transport.findOne({ kind: 'coverage', sourceId }) === null, 'Unknown source advanced coverage.');
  assert((await stores.settlements.countDocuments({ scenario, kind: 'ack' })) === 0, 'Unknown source was ACKed.');
  const retryDepth = (await channel.checkQueue(`${queue}.retry`)).messageCount;
  assert(retryDepth === 1, 'Unknown-source durable retry was not retained.');
  return { rejected: true, retryDepth, reason: settlement.reason };
}

async function verifyReducedRegistry(client: MongoClient, queue: string): Promise<boolean> {
  const manifest = stackManifest(queue);
  const reduced = { ...manifest, definitions: manifest.definitions.slice(0, -1) };
  const store = new MongoProjectionTransportStore({
    collection: client.db(databaseName).collection(`${'crash_after_coverage'}_transport`),
    mongoClient: client,
    manifest: reduced
  });
  try { await store.initialize(); return false; } catch { return true; }
}

async function resourceIsAbsent(kind: 'queue' | 'exchange', name: string): Promise<boolean> {
  const connection = await connect(rabbitUri);
  connection.on('error', () => undefined);
  const probe = await connection.createChannel();
  probe.on('error', () => undefined);
  try {
    if (kind === 'queue') await probe.checkQueue(name);
    else await probe.checkExchange(name);
    return false;
  } catch {
    return true;
  } finally {
    await probe.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function cleanupLogical(client: MongoClient, channel: ConfirmChannel): Promise<void> {
  for (const queue of queues) {
    await channel.deleteQueue(queue);
    await channel.deleteQueue(`${queue}.dead`);
    await channel.deleteQueue(`${queue}.retry`);
    await channel.deleteExchange(`${queue}.dlx`);
  }
  await client.db(databaseName).dropDatabase();
  const databases = await client.db('admin').admin().listDatabases();
  assert(!databases.databases.some((entry) => entry.name === databaseName), 'Database cleanup verification failed.');
  for (const queue of queues) {
    for (const queueName of [queue, `${queue}.dead`, `${queue}.retry`]) {
      assert(await resourceIsAbsent('queue', queueName), `Queue cleanup verification failed: ${queueName}`);
    }
    assert(await resourceIsAbsent('exchange', `${queue}.dlx`), `Exchange cleanup verification failed: ${queue}`);
  }
}

async function startSource(client: MongoClient): Promise<{
  partition: Awaited<ReturnType<InstanceType<typeof EventStore>['openPartition']>>;
  first: ICommit<StackEvent>;
  collection: Collection<ICommit<StackEvent>>;
  commits: readonly ICommit<StackEvent>[];
}> {
  const db = client.db(databaseName);
  const partition = await (Reflect.construct(EventStore, [new MongoTapewormPersistence(db)]) as InstanceType<typeof EventStore>)
    .openPartition(PARTITION_ID);
  const commits = [tapewormCommit(0, [1, 1]), tapewormCommit(1, [1])];
  await partition.append([commits[0] as ICommit<StackEvent>]);
  const collection = db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`);
  const first = await collection.findOne({ streamId: SOURCE_ID, commitSequence: 0 });
  assert(first?.events.length === 2, 'Published Tapeworm writer did not persist complete sequence0.');
  return { partition, first, collection, commits };
}

async function run(): Promise<void> {
  const client = new MongoClient(mongoUri);
  const rabbit = await connect(rabbitUri);
  const channel = await rabbit.createConfirmChannel();
  await client.connect();
  const { partition, first, collection, commits } = await startSource(client);
  const db = client.db(databaseName);

  const normal = await runNormalSequenceZero(client, channel, first);
  const crashes = [];
  crashes.push(await runCrashScenario(client, channel, first, 'before_save', 4));
  crashes.push(await runCrashScenario(client, channel, first, 'after_p', 4));
  crashes.push(await runCrashScenario(client, channel, first, 'after_all', 6));
  crashes.push(await runCrashScenario(client, channel, first, 'after_coverage', 4));
  await partition.append([commits[1] as ICommit<StackEvent>]);
  const sliced = await partition.queryStream?.(SOURCE_ID, 1);
  assert(sliced?.[0]?.events.length === 1, 'Published Tapeworm sliced query behavior was not observed.');
  const persisted = await collection.find({ streamId: SOURCE_ID }).sort({ commitSequence: 1 }).toArray();
  assert(persisted.length === 2 && persisted[0]?.events.length === 2, 'Published Tapeworm writer did not persist complete commits.');
  const gap = await runGapAndReconnect(client, channel, persisted);
  const poison = await runPoisonAndRetry(client, channel);
  const coverageQueue = `${databaseName}.crash_after_coverage`;
  const reducedRegistryRejected = await verifyReducedRegistry(client, coverageQueue);
  assert(reducedRegistryRejected, 'Reduced registry was accepted.');

  const indexes = await collection.listIndexes().toArray();
  const rangeIndex = indexes.find((index) => Object.keys(index.key ?? {}).join(',') === 'streamId,commitSequence');
  assert(rangeIndex?.name, 'Tapeworm range index missing after writer initialization.');
  const explain = await collection.find({ streamId: SOURCE_ID, commitSequence: { $gt: -1, $lte: 1 } })
    .sort({ commitSequence: 1 }).hint(rangeIndex.name).limit(3).batchSize(1).explain('executionStats');
  const server = await db.admin().command({ buildInfo: 1 });
  const rabbitVersion = rabbit.connection.serverProperties.version;
  await cleanupLogical(client, channel);
  await channel.close();
  await rabbit.close();
  await client.close();
  await writeFile(evidencePath, JSON.stringify({
    qualification: 'scenarios_complete_cleanup_pending', gitSha,
    versions: { tapeworm: '0.6.0', tapewormMongo: '3.1.0', mongodbDriver: '6.18.0', mongoServer: server.version, rabbitServer: rabbitVersion, amqplib: '2.0.1' },
    images: { mongo: process.env.REDEMEINE_MONGO_DIGEST, rabbit: process.env.REDEMEINE_RABBIT_DIGEST },
    databaseName, queues, childRuns, multiEventCount: persisted[0]?.events.length,
    slicedQueryObserved: true, normal, crashes, gap, poison, reducedRegistryRejected,
    index: { name: rangeIndex.name, key: rangeIndex.key, unique: rangeIndex.unique, collation: rangeIndex.collation ?? 'default' },
    query: { filter: { streamId: SOURCE_ID, commitSequence: { $gt: -1, $lte: 1 } }, sort: { commitSequence: 1 }, hint: rangeIndex.name, limit: 3, batchSize: 1, winningPlan: explain.queryPlanner?.winningPlan },
    logicalCleanupVerified: true
  }), { flag: 'wx' });
}

await run();
