import { connect, type Channel, type ConsumeMessage } from 'amqplib';
import { MongoClient, type Collection } from 'mongodb';
import EventStore, { Commit, type ICommit } from 'tapeworm';
import type {
  ProjectionCommitCoordinator,
  ProjectionCommitCoordinatorOutcome
} from '@redemeine/projection-worker-core';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import {
  createTapewormCompleteCommitRangeReader,
  MongoProjectionTransportStore,
  ProjectionRabbitWorker,
  type ProjectionRabbitChannel,
  type ProjectionTransportDocument,
  type RabbitDelivery
} from '../src';

const mongoUri = process.env.REDEMEINE_MONGO_URI;
const rabbitUri = process.env.REDEMEINE_RABBIT_URI;
if (!mongoUri || !rabbitUri) throw new Error('Real stack connection variables are required.');
const mongoConnectionUri = mongoUri;
const rabbitConnectionUri = rabbitUri.replace('localhost', '127.0.0.1');

const sourceId = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'1'.repeat(64)}` as const;
const databaseName = `redemeine_projection_transport_${Date.now()}`;
const queue = `projection-direct-${Date.now()}`;
const manifest: ProjectionQueueRegistryManifest = {
  version: 1, manifestId: digest, queueId: queue, registryGeneration: 'v1',
  identity: {
    version: 1, normalizedDefinitionRegistryDigest: digest,
    normalizedRuntimeConfigurationDigest: digest, executableCodeArtifactDigest: digest
  },
  definitions: [{ projectionName: 'P-own', generation: 'v1', definitionHash: digest, sourceSelectors: ['Order'] }],
  sourceStartAnchors: { [sourceId]: 0 }
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function event(id: string, version: number) {
  return {
    id, type: `Changed${version}`, version, aggregateType: 'Order', aggregateId: 'one',
    payload: { version }, timestamp: '2026-09-22T00:00:00.000Z', headers: { trace: version }, metadata: { index: version }
  };
}

function createCommits(): readonly ICommit[] {
  return [
    new Commit('22222222-2222-4222-8222-222222222222', 'orders', sourceId, 0, [
      event('33333333-3333-4333-8333-333333333333', 0),
      event('44444444-4444-4444-8444-444444444444', 1)
    ]),
    new Commit('55555555-5555-4555-8555-555555555555', 'orders', sourceId, 1, [
      event('66666666-6666-4666-8666-666666666666', 2)
    ])
  ];
}

function adaptChannel(channel: Channel): ProjectionRabbitChannel {
  const originals = new WeakMap<object, ConsumeMessage>();
  const original = (message: RabbitDelivery): ConsumeMessage => {
    const value = originals.get(message);
    if (!value) throw new Error('Missing original Rabbit delivery.');
    return value;
  };
  return {
    assertExchange: (name, type, options) => channel.assertExchange(name, type, options),
    assertQueue: (name, options) => channel.assertQueue(name, options),
    prefetch: (count) => channel.prefetch(count),
    consume: (name, handler, options) => channel.consume(name, (message) => {
      if (!message) return handler(null);
      const projected: RabbitDelivery = {
        content: message.content,
        fields: { deliveryTag: message.fields.deliveryTag, redelivered: message.fields.redelivered },
        properties: { ...(message.properties.messageId ? { messageId: message.properties.messageId } : {}) }
      };
      originals.set(projected, message);
      handler(projected);
    }, options),
    cancel: (tag) => channel.cancel(tag),
    ack: (message) => channel.ack(original(message)),
    nack: (message, allUpTo, requeue) => channel.nack(original(message), allUpTo, requeue)
  };
}

async function qualifyTapeworm(commits: readonly ICommit[]): Promise<number> {
  const eventStore = new EventStore();
  const partition = await eventStore.openPartition('orders');
  await partition.append([...commits]);
  const sliced = await partition.queryStream?.(sourceId, 1);
  assert(sliced?.[0]?.events.length === 1, 'Tapeworm queryStream sliced-first-commit behavior was not observed.');
  let indexedReads = 0;
  const reader = createTapewormCompleteCommitRangeReader({
    completeCommitBoundaries: true,
    indexedByCommitSequence: true,
    async readCommitRangeByCommitSequence(request) {
      indexedReads += 1;
      return commits.filter((commit) => commit.commitSequence > (request.afterCommitSequence ?? -1)
        && commit.commitSequence <= request.throughCommitSequence).slice(0, request.limit)
        .map((commit) => ({ commit, encodedByteLength: Buffer.byteLength(JSON.stringify(commit)) }));
    }
  });
  const range = await reader.readCompleteRange({ sourceId, afterSequence: null, throughSequence: 1, maxCommits: 100, maxBytes: 1_048_576 });
  assert(range.status === 'complete' && range.commits.length === 2 && range.commits[0]?.commit.events.length === 2, 'Complete commit range failed.');
  return indexedReads;
}

async function qualifyMongo(client: MongoClient, collection: Collection<ProjectionTransportDocument>, commits: readonly ICommit[]) {
  const store = new MongoProjectionTransportStore({ collection, mongoClient: client, manifest });
  await store.initialize();
  const decodedReader = createTapewormCompleteCommitRangeReader({
    completeCommitBoundaries: true, indexedByCommitSequence: true,
    readCommitRangeByCommitSequence: async ({ afterCommitSequence }) => commits
      .filter((item) => item.commitSequence > (afterCommitSequence ?? -1))
      .map((commit) => ({ commit, encodedByteLength: Buffer.byteLength(JSON.stringify(commit)) }))
  });
  const first = await decodedReader.readCompleteRange({ sourceId, afterSequence: null, throughSequence: 0, maxCommits: 1, maxBytes: 1_048_576 });
  assert(first.status === 'complete', 'Sequence zero commit unavailable.');
  const firstEntry = first.commits.at(0);
  assert(firstEntry !== undefined, 'Sequence zero commit unavailable.');
  const commit = firstEntry.commit;
  const admission = await store.admitForDispatch(commit, queue);
  assert(admission.dispatch && admission.coverage.sequence === null, 'Cold admission failed.');
  await store.advanceCoverage({ queueBindingId: queue, sourceId, expectedSequence: null, sequence: 0 });
  assert((await store.admitForDispatch(commit, queue)).coverage.sequence === 0, 'Redelivery coverage failed.');

  let throwAfterWrite = true;
  const uncertain = new Proxy(collection, {
    get(target, property, receiver) {
      if (property !== 'updateOne') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<Collection<ProjectionTransportDocument>['updateOne']>) => {
        const result = await target.updateOne(...args);
        if (throwAfterWrite && (args[0] as Record<string, unknown>).sequence === 0) {
          throwAfterWrite = false;
          throw new Error('simulated unknown update outcome');
        }
        return result;
      };
    }
  });
  const reconciling = new MongoProjectionTransportStore({ collection: uncertain, mongoClient: client, manifest });
  const advanced = await reconciling.advanceCoverage({ queueBindingId: queue, sourceId, expectedSequence: 0, sequence: 1 });
  assert(advanced.sequence === 1, 'Unknown coverage outcome was not reconciled.');

  const reduced = { ...manifest, definitions: [] };
  const mismatched = new MongoProjectionTransportStore({ collection, mongoClient: client, manifest: reduced });
  let rejected = false;
  try { await mismatched.initialize(); } catch { rejected = true; }
  assert(rejected, 'Reduced immutable registry was accepted.');
  return store;
}

async function qualifyRabbit(channel: Channel, store: MongoProjectionTransportStore, commit: ICommit): Promise<number> {
  await channel.assertExchange('projection-dlx', 'direct', { durable: true });
  let dispatches = 0;
  const coordinator: ProjectionCommitCoordinator = {
    async process(): Promise<ProjectionCommitCoordinatorOutcome> {
      dispatches += 1;
      return { status: 'completed', processedSequences: [commit.commitSequence], definitions: [] };
    }
  };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const worker = new ProjectionRabbitWorker({
    queue, deadLetterExchange: 'projection-dlx', prefetch: 2, maxMessageBytes: 1_048_576, retryBackoffMs: 1_000,
    coordinator, initialize: () => store.initialize(),
    scheduleRetry: async () => ({ durable: true, notBeforeEpochMs: Date.now() + 1_000 }),
    observeSettlement: (result) => { if (result.kind === 'ack') settle(); }
  });
  await worker.start(adaptChannel(channel));
  channel.sendToQueue(queue, Buffer.from(JSON.stringify(commit)), { persistent: true, messageId: commit.id });
  await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error('Rabbit ACK timeout')), 10_000))]);
  await worker.stop();
  return dispatches;
}

async function run(): Promise<void> {
  const mongo = new MongoClient(mongoConnectionUri, { retryWrites: false });
  const rabbit = await connect(rabbitConnectionUri);
  const channel = await rabbit.createChannel();
  const commits = createCommits();
  try {
    await mongo.connect();
    const collection = mongo.db(databaseName).collection<ProjectionTransportDocument>('projectionTransport');
    const indexedReads = await qualifyTapeworm(commits);
    const store = await qualifyMongo(mongo, collection, commits);
    const dispatches = await qualifyRabbit(channel, store, commits[0] as ICommit);
    const indexes = await collection.listIndexes().toArray();
    console.log(JSON.stringify({
      status: 'PASS', tapeworm: '0.6.0', amqplib: '2.0.1', rabbit: '4.1.4', mongo: '8.0.14',
      mongoDriver: '6.18.0', mongoDigest: process.env.REDEMEINE_MONGO_DIGEST,
      rabbitDigest: process.env.REDEMEINE_RABBIT_DIGEST, multiEventCount: commits[0]?.events.length,
      slicedFirstCommitObserved: true, indexedReads, coverageUnknownReconciled: true,
      reducedRegistryRejected: true, directAckDispatches: dispatches,
      nonTtlIndexes: indexes.filter((index) => index.name?.startsWith('projection_transport_')).length,
      databaseDropped: databaseName, queueDeleted: queue
    }));
  } finally {
    await channel.deleteQueue(queue).catch(() => undefined);
    await channel.close().catch(() => undefined);
    await rabbit.close().catch(() => undefined);
    await mongo.db(databaseName).dropDatabase().catch(() => undefined);
    await mongo.close().catch(() => undefined);
  }
}

await run();
