import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, type ConfirmChannel } from 'amqplib';
import type { Db, MongoClient } from 'mongodb';
import { MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDedupeRecord } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { ProjectionRabbitWorker, SourceTailPoller, type RabbitSettlementEvent } from '../src';
import type { State } from './joinMembershipFixture';
import { joinBindingConfiguration, seedJoinBinding } from './realJoinBinding';
import { adaptChannel } from './realStackFixtures';
import { waitForSettlement } from './settlementWait';

export async function deliverTail(channel: ConfirmChannel, queue: string, setup: Awaited<ReturnType<typeof seedJoinBinding>>,
  createWorker: (observe: (event: RabbitSettlementEvent) => void) => ProjectionRabbitWorker) {
  await channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true, arguments: {} });
  await channel.assertQueue(queue, { durable: true, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed' });
  let settle!: (event: RabbitSettlementEvent) => void;
  const settlement = new Promise<RabbitSettlementEvent>((resolve) => { settle = resolve; });
  const worker = createWorker(settle);
  try {
    await worker.start(adaptChannel(channel));
    const { collection, tail } = setup.indexed;
    const notification = tail[1]!;
    assert.equal(await setup.sourceOrder.loadCoveredThrough(queue, notification.streamId), null);
    await collection.insertMany(tail);
    assert(channel.sendToQueue(queue, Buffer.from(JSON.stringify(notification)), { persistent: true, messageId: notification.id }));
    await channel.waitForConfirms();
    await waitForSettlement(settlement.then(({ kind }) => assert.equal(kind, 'ack')), 10_000);
  } finally {
    await worker.stop();
    await channel.deleteQueue(queue);
    await channel.deleteExchange(`${queue}.dlx`);
  }
}

export async function runJoinRabbit(db: Db, client: MongoClient, uri: string) {
  const source = randomUUID();
  const queue = `${db.databaseName}.set`;
  const config = joinBindingConfiguration(true, true, source, queue, true);
  const setup = await seedJoinBinding(db, client, true, config.manifest, source, true);
  const { indexed: { reader }, docs, links, sourceOrder } = setup;
  const changeCollection = db.collection<MongoProjectionChangesRecord>('changes');
  const dedupeCollection = db.collection<ProjectionDedupeRecord>('progress');
  const store = new MongoProjectionStore<State>({ collection: db.collection('views'), linkCollection: db.collection('scalar'),
    joinMembershipCollection: db.collection('members'), dedupeCollection, changeCollection, mongoClient: client });
  const coordinator = createProjectionCommitCoordinator({ ...config, queueBindingId: queue, sourceOrder, store,
    rangeReader: reader, maxCommits: 4, maxBytes: 100_000 });
  const failures: string[] = [];
  const sourceTail = new SourceTailPoller({ queueId: queue, sourceIds: [source], transport: sourceOrder, reader, coordinator,
    maxCommits: 4, maxBytes: 100_000, maxPages: 1, intervalMs: 60_000, onFailure: (error) => failures.push(error.message) });
  const rabbit = await connect(uri.replace('localhost', '127.0.0.1'));
  try {
    const channel = await rabbit.createConfirmChannel();
    await deliverTail(channel, queue, setup, (observeSettlement) => new ProjectionRabbitWorker({
      queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed', prefetch: 1, maxMessageBytes: 100_000,
      retryBackoffMs: 100, coordinator, sourceTail, initialize: () => sourceOrder.initialize(), observeSettlement,
      scheduleRetry: async () => { throw new Error('Unexpected retry in set-mode stack.'); }
    }));
    await channel.close();
    const views = (await docs.find().sort({ _id: 1 }).toArray()).map(({ state }) => state.visits.length);
    const membership = await links.findOne();
    const receipts = (await changeCollection.find().sort({ commitSequence: 1 }).toArray()).map(({ commitSequence }) => commitSequence);
    const covered = await sourceOrder.loadCoveredThrough(queue, source);
    assert.deepEqual(views, [2, 2, 1]);
    assert.deepEqual(membership?.targetDocumentIds, ['A', 'B', 'C']);
    assert.equal(membership?.revision, 2);
    assert.deepEqual(receipts, [1, 2]);
    assert.equal((await dedupeCollection.findOne({ sourceId: source }))?.commitSequence, 2);
    assert.equal(covered, 2);
    assert.deepEqual(failures, []);
    assert.equal(reader.getIndexName(), 'sourceRange');
    return { name: 'rabbit-set-gap-attach', index: reader.getIndexName(), receipts, covered, views,
      acknowledgements: 1, membershipRevision: membership.revision, targets: membership.targetDocumentIds,
      rabbit: rabbit.connection.serverProperties.version };
  } finally {
    await rabbit.close();
  }
}
