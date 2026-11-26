import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import type { Db, MongoClient } from 'mongodb';
import {
  decodeMongoProjectionChangesReceipt, MongoProjectionStore, type MongoProjectionChangesRecord,
  type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator, joinSeedDeployments } from '@redemeine/projection-worker-core';
import {
  normalizeProjectionRegistryDefinitions, projectionDefinitionHash, projectionDefinitionRegistryDigest,
  projectionQueueRegistryDigest, projectionRuntimeConfigurationDigest, ProjectionRabbitWorker, SourceTailPoller
} from '../src';
import { orderId } from './joinMembershipFixture';
import { evidence, generation, type State, viewFixture } from './joinSeedFixture';
import { joinBindingConfiguration, seedJoinBinding } from './realJoinBinding';
import { deliverTail } from './realJoinRabbit';

async function setupSeedRabbit(db: Db, client: MongoClient, source: string, queue: string) {
  const producer = db.collection<{ _id: string; state: { booking: { total: number } }; through: number; streamId: string }>('producer');
  await producer.insertOne({ _id: orderId, state: { booking: { total: 30 } }, through: 1, streamId: source });
  let reads = 0;
  const { definition, reader: provider } = viewFixture(async (id) => {
    reads += 1;
    const row = await producer.findOne({ _id: id }, { readConcern: { level: 'majority' } });
    return row && { state: row.state, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: row.streamId, commitSequence: row.through }) };
  });
  const definitions = [{ definition, generation, projectionChanges: 'join-changes', joinSeedReaders: [provider] }];
  const base = joinBindingConfiguration(true, true, source, queue).manifest;
  const config = normalizeProjectionRegistryDefinitions(definitions, [{}]);
  const artifact = base.identity.executableCodeArtifactDigest;
  const entries = [{ ...base.definitions[0]!, generation, joinSeeds: joinSeedDeployments([provider]),
    definitionHash: projectionDefinitionHash(config[0]!, artifact) }];
  const registry = { ...base, definitions: entries, identity: { ...base.identity,
    normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(entries),
    normalizedRuntimeConfigurationDigest: projectionRuntimeConfigurationDigest(config) } };
  const { manifestId: _, ...body } = registry;
  const manifest = { ...body, manifestId: projectionQueueRegistryDigest(body) };
  const setup = await seedJoinBinding(db, client, true, manifest, source, true, false, {
    scope: { projectionName: definition.name, generation }, initialView: () => ({ total: 0, effects: [] }),
    eventAt: (sequence) => sequence === 1 ? { type: 'assign', payload: { to: 'C', amount: 5 } }
      : { type: 'delta', payload: { amount: 7 } }
  });
  const changes = db.collection<MongoProjectionChangesRecord>('changes');
  const store = new MongoProjectionStore<State>({ collection: db.collection<ProjectionDocumentRecord<State>>('views'),
    linkCollection: db.collection('scalar'), joinMembershipCollection: db.collection<ProjectionJoinMembershipRecord>('members'),
    dedupeCollection: db.collection('progress'), changeCollection: changes, mongoClient: client });
  return { setup, store, changes, manifest, definitions, readCount: () => reads };
}

export async function runJoinSeedRabbit(db: Db, client: MongoClient, uri: string) {
  const source = randomUUID();
  const queue = `${db.databaseName}.initialize`;
  const { setup, store, changes, manifest, definitions, readCount } = await setupSeedRabbit(db, client, source, queue);
  const { indexed: { reader }, sourceOrder, links } = setup;
  const failures: string[] = [];
  const coordinator = createProjectionCommitCoordinator({ manifest, definitions, queueBindingId: queue, sourceOrder, store,
    rangeReader: reader, maxCommits: 4, maxBytes: 100_000 });
  const sourceTail = new SourceTailPoller({ queueId: queue, sourceIds: [source], transport: sourceOrder, reader, coordinator,
    maxCommits: 4, maxBytes: 100_000, maxPages: 1, intervalMs: 60_000, onFailure: (error) => failures.push(error.message) });
  const rabbit = await connect(uri.replace('localhost', '127.0.0.1'));
  try {
    const channel = await rabbit.createConfirmChannel();
    await deliverTail(channel, queue, setup, (observeSettlement) => new ProjectionRabbitWorker({
      queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed', prefetch: 1, maxMessageBytes: 100_000,
      retryBackoffMs: 100, coordinator, sourceTail, initialize: () => sourceOrder.initialize(), observeSettlement,
      scheduleRetry: async () => { throw new Error('Unexpected retry in initialization stack.'); }
    }));
    await channel.close();
    const covered = await sourceOrder.loadCoveredThrough(queue, source);
    assert.equal(covered, 2);
    assert.deepEqual(failures, []);
    assert.equal(readCount(), 1);
    assert.equal((await store.load('C'))?.total, 37);
    const proof = evidence(orderId, 'projection', { kind: 'throughCommit', streamId: source, commitSequence: 1 });
    assert.deepEqual((await links.findOne())?.seeds, [{ targetDocumentId: 'C', provenance: proof }]);
    const receipts = (await changes.find().sort({ commitSequence: 1 }).toArray()).map(decodeMongoProjectionChangesReceipt);
    assert.deepEqual(receipts.map(({ commitSequence }) => commitSequence), [1, 2]);
    const seedReceipt = receipts[0];
    assert(seedReceipt?.kind === 'projection_changes');
    assert.deepEqual(seedReceipt.targets.find(({ targetDocumentId }) => targetDocumentId === 'C')?.transitions[0]?.joinSeeds, [proof]);
    assert.equal(reader.getIndexName(), 'sourceRange');
    return { name: 'rabbit-native-seeded-attach', index: reader.getIndexName(), providerReads: readCount(),
      acknowledgements: 1, covered, total: 37, receipts: [1, 2] };
  } finally { await rabbit.close(); }
}
