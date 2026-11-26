import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createProjectionDispatchBindingProof, matchesProjectionDispatchBinding, ProjectionDispatchBindingMismatchError,
  projectionUuidToBase64Url22, type ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import {
  MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { MongoClient, type Db } from 'mongodb';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { manifest, orderId } from './joinMembershipFixture';
import { conflict, crossSourceMismatch, failures, order, proven, providerRace, sourceOnlyMetadata, unknown } from './joinSeedScenarios';
import { evidence, fixtureRuntime, OrderProjection, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { recoverSeedReceipt } from './joinSeedReceiptRace';

function memory(): Backend {
  const store = new InMemoryProjectionStore<State>();
  return { store: () => store, history: async () => store.getProjectionChanges() };
}

function mongo(db: Db, client: MongoClient): Backend {
  const changes = db.collection<MongoProjectionChangesRecord>('changes');
  const store = () => new MongoProjectionStore({
    collection: db.collection<ProjectionDocumentRecord<State>>('boards'),
    joinMembershipCollection: db.collection<ProjectionJoinMembershipRecord>('memberships'),
    linkCollection: db.collection('legacy_scalar'), dedupeCollection: db.collection('progress'),
    changeCollection: changes, mongoClient: client
  });
  return { store, history: async () => (await changes.find({ kind: 'projection_changes' }).toArray())
    .filter((entry) => entry.kind === 'projection_changes') };
}

async function allCases(backend: () => Backend) {
  await proven(backend());
  await unknown(backend());
  await failures(backend());
  await sourceOnlyMetadata(backend());
  await crossSourceMismatch(backend());
  await providerRace(backend());
  await conflict(backend(), false);
  await conflict(backend(), true);
  await recoverSeedReceipt(backend(), false);
  await recoverSeedReceipt(backend(), true);
}

async function rollback(db: Db, client: MongoClient) {
  await db.createCollection('changes', { validator: { _id: '__never_write_this_receipt__' } });
  const backend = mongo(db, client);
  const streamId = randomUUID();
  let reads = 0;
  const enabled = fixtureRuntime(backend, viewFixture(async () => {
    reads += 1;
    return { state: { booking: { total: 30 } }, provenance: evidence(orderId, 'projection', { kind: 'throughCommit', streamId, commitSequence: 0 }) };
  }));
  const c = order(streamId, 0, [['assign', { to: 'a', amount: 15 }]]);
  assert.notEqual((await enabled.start().process(c)).status, 'completed');
  assert.equal(reads, 1);
  assert.equal(enabled.coverage.has(streamId), false);
  const rejected = await read(backend, streamId, 'a');
  assert.equal(rejected.row.revision, null);
  assert.equal(rejected.progress, null);
  assert.equal(rejected.states[0], null);
  assert.equal((await backend.history()).length, 0);
  await db.command({ collMod: 'changes', validator: {} });
  assert.equal((await enabled.start().process(c)).status, 'completed');
  assert.equal((await read(backend, streamId, 'a')).states[0]?.total, 30);
  assert.equal(reads, 2);
}

async function coherentProducer(db: Db, client: MongoClient) {
  type ProducerState = ReturnType<typeof OrderProjection.initialState>;
  const views = db.collection<ProjectionDocumentRecord<ProducerState>>('producer_views');
  const store = new MongoProjectionStore({ collection: views, linkCollection: db.collection('producer_scalar'),
    dedupeCollection: db.collection('producer_progress'), mongoClient: client });
  const streamId = randomUUID();
  const m = manifest('producer-queue');
  const producer = { projectionName: OrderProjection.name, generation: 'producer-g1',
    strategy: 'in_document' as const, stableSingleTarget: true };
  let sequence: number | null = null;
  const registry = { ...m, definitions: [{
    projectionName: producer.projectionName, generation: producer.generation,
    sourceSelectors: ['Order'], definitionHash: m.manifestId
  }] };
  const boundDispatchProof = createProjectionDispatchBindingProof(registry);
  const runtime = createProjectionCommitCoordinator({ manifest: registry,
  queueBindingId: m.queueId, store, definitions: [{ generation: producer.generation, definition: OrderProjection }],
  maxBytes: 10000, maxCommits: 2, sourceOrder: {
    async admitForDispatch(commit: ProjectionSourceCommit, queueBindingId, expected) {
      if (!matchesProjectionDispatchBinding(expected, boundDispatchProof)) throw new ProjectionDispatchBindingMismatchError();
      return { dispatch: true, coverage: { queueBindingId, sourceId: commit.streamId, sequence },
        startAnchor: 0, strategyScope: [producer], boundDispatchProof };
    },
    async advanceCoverage({ queueBindingId, sourceId, sequence: next }) {
      sequence = next;
      return { queueBindingId, sourceId, sequence: next };
    }
  }, rangeReader: { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    async readCompleteRange(): Promise<never> { throw new Error('Unexpected producer gap.'); } } });
  const start = order(streamId, 0, [['assign', { to: 'a', amount: 12 }], ['delta', { amount: 4 }]]);
  assert.equal((await runtime.process(start)).status, 'completed');
  assert.equal((await runtime.process(order(streamId, 1, [['delta', { amount: 14 }]]))).status, 'completed');
  await proven(mongo(db, client), { streamId, async readOne(id) {
    const row = await views.findOne({ _id: id }, { readConcern: { level: 'majority' } });
    const sourceSequence = row?.sourceProgress?.[projectionUuidToBase64Url22(streamId)];
    if (!row || sourceSequence === undefined) return null;
    // This fixture's producer has stable per-Order routing and starts at known source genesis.
    return { state: row.state, provenance: evidence(id, 'projection', { kind: 'throughCommit', streamId, commitSequence: sourceSequence }) };
  } });
}

async function latestAggregateSnapshot(db: Db, client: MongoClient) {
  const snapshots = db.collection<{ _id: string; warehouse: { remaining: number[] } }>('persisted_aggregate_snapshots');
  await snapshots.insertOne({ _id: orderId, warehouse: { remaining: [75] } });
  await unknown(mongo(db, client), async (id) => {
    const row = await snapshots.findOne({ _id: id }, { readConcern: { level: 'majority' } });
    return row && { state: { warehouse: row.warehouse }, provenance: evidence(id, 'snapshot', { kind: 'unknown' }) };
  });
}

async function main() {
  await allCases(memory);
  console.log('Join initialization: in-memory scenarios passed.');
  const uri = process.env.REDEMEINE_MONGO_URI;
  if (!uri) return;
  const client = new MongoClient(uri);
  const databases: Db[] = [];
  function db() {
    const temporary = client.db(`cdyb_${randomUUID().replaceAll('-', '')}`);
    databases.push(temporary);
    return temporary;
  }
  try {
    await allCases(() => mongo(db(), client));
    await rollback(db(), client);
    await coherentProducer(db(), client);
    await latestAggregateSnapshot(db(), client);
    const corruptDb = db();
    await recoverSeedReceipt(mongo(corruptDb, client), true, async () => {
      const result = await corruptDb.collection('memberships').updateOne({}, { $set: { seeds: [null] } });
      assert.equal(result.modifiedCount, 1);
    });
    console.log('Join initialization: replica-set scenarios passed, including coherent producer read and receipt rollback.');
  } finally {
    for (const database of databases) await database.dropDatabase();
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
