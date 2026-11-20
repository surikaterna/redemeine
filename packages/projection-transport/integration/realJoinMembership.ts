import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BSON, MongoClient, type CommandStartedEvent, type Db, type Document } from 'mongodb';
import {
  MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, routed, snapshot, type State, turn } from './joinMembershipFixture';
import { completed, runDisjointAttach, runFirstCandidateWrite, runNone, runRace, runRouting } from './joinMembershipScenarios';
import { runJoinMembershipCutover } from './realJoinMembershipCutover';
import { runJoinBinding } from './realJoinBinding';
import { runJoinInvalidRows } from './realJoinInvalidRows';
import { runJoinReceiptRaces } from './realJoinReceiptRace';
import { runFracturedReadRegression, runMultiEventBatch } from './joinMembershipMongoAudit';

function mongoResources(db: Db, client: MongoClient) {
  const collection = db.collection<ProjectionDocumentRecord<State>>('views');
  const joinMembershipCollection = db.collection<ProjectionJoinMembershipRecord>('memberships');
  const changeCollection = db.collection<MongoProjectionChangesRecord>('changes');
  const makeStore = (views = collection) => new MongoProjectionStore({
    collection: views, joinMembershipCollection, changeCollection, mongoClient: client,
    linkCollection: db.collection('scalar'), dedupeCollection: db.collection('progress')
  });
  return { makeStore, collection, joinMembershipCollection, changeCollection };
}

async function runRollback(db: Db, client: MongoClient, commands: CommandStartedEvent[]) {
  const { makeStore, collection, joinMembershipCollection, changeCollection } = mongoResources(db, client);
  await db.createCollection('changes', { validator: { _id: '__reject_source_turn__' } });
  await db.createCollection('memberships');
  const store = makeStore();
  await store.initializeProjectionSourceCommitStore();
  const options = fixtureOptions(store);
  const runtime = coordinator(options);
  const source = randomUUID();
  commands.length = 0;
  const original = turn(source, 0, orderId, [[routed, { targets: ['A', 'B'], to: 'A' }]]);
  await assert.rejects(async () => completed(runtime, original));
  const attemptCommands = commands.filter((command) => command.databaseName === db.databaseName);
  const keys = attemptCommands.map(({ command }) => command.update ?? command.insert ?? command.find);
  assert(keys.includes('views') && keys.includes('memberships') && keys.includes('progress') && keys.includes('changes'));
  assert(commands.some(({ commandName }) => commandName === 'abortTransaction'));
  assert.equal(await collection.countDocuments(), 0);
  assert.equal(await joinMembershipCollection.countDocuments(), 0);
  assert.equal(await changeCollection.countDocuments(), 0);
  assert.equal((await snapshot(store, source)).ownRecordSequence, null);
  assert.equal(await fixtureCoverage(options, original), null);
  await db.command({ collMod: 'changes', validator: {} });
  await completed(runtime, original);
  assert.equal(await changeCollection.countDocuments(), 1);
}

async function runScale(db: Db, client: MongoClient, commands: CommandStartedEvent[], count: number) {
  const { makeStore, collection, joinMembershipCollection, changeCollection } = mongoResources(db, client);
  const store = makeStore();
  await store.initializeProjectionSourceCommitStore();
  const runtime = coordinator(fixtureOptions(store));
  const targets = Array.from({ length: count }, (_, index) => `target-${String(index).padStart(4, '0')}`);
  await completed(runtime, turn(randomUUID(), 0, targets[0]!, [['attach', { order: 'other-order' }]], 'Board'));
  const source = randomUUID();
  const c = turn(source, 0, orderId, [[routed, { targets, attachAll: true, extra: 'other-order' }]]);
  const result = await measureScale(db, commands, count, 'candidate-and-attach', () => runtime.process(c));
  assert.equal(result.status, count > 1024 ? 'terminal' : 'completed', JSON.stringify(result));
  assert.equal(await collection.countDocuments(), count > 1024 ? 1 : count);
  assert.equal(await joinMembershipCollection.countDocuments(), count > 1024 ? 1 : 2);
  assert.equal(await changeCollection.countDocuments(), count > 1024 ? 1 : 2);
  const row = await snapshot(store, source);
  assert.equal(row.ownRecordSequence, count > 1024 ? null : 0);
  if (count > 1024) return;
  assert.deepEqual(row.joinMemberships?.[0]?.targetDocumentIds, targets);
  const next = turn(source, 1, orderId, [['ordinary']]);
  const fanout = await measureScale(db, commands, count, 'saved-fanout', () => runtime.process(next));
  assert.equal(fanout.status, 'completed', JSON.stringify(fanout));
  assert.equal(await collection.countDocuments({ 'state.visits': 'ordinary' }), count);
  if (count === 1024) {
    const excess = await runtime.process(turn(source, 2, orderId, [[routed, { targets: 'extra-target' }]]));
    assert.equal(excess.status, 'terminal', JSON.stringify(excess));
    const afterExcess = await snapshot(store, source);
    assert.deepEqual(afterExcess.joinMemberships?.[0]?.targetDocumentIds, targets);
    assert.equal(afterExcess.ownRecordSequence, 1);
    assert.equal(await collection.countDocuments(), count);
  }
}

async function measureScale<T extends Awaited<ReturnType<ReturnType<typeof coordinator>['process']>>>(db: Db,
  commands: CommandStartedEvent[], count: number, phase: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  commands.length = 0;
  const result = await run();
  const elapsedMs = performance.now() - start;
  const relevant = commands.filter(({ databaseName, commandName }) =>
    databaseName === db.databaseName && ['find', 'insert', 'update', 'getMore'].includes(commandName));
  const countCommands = (name: string) => relevant.filter(({ command }) =>
    [command.find, command.update, command.insert, command.collection].includes(name)).length;
  assert(countCommands('views') <= Math.ceil(count / 256) * 5 + 1);
  console.log(JSON.stringify({ count, phase, elapsedMs, viewCommands: countCommands('views'), membershipCommands: countCommands('memberships'),
    totalCommands: relevant.length, commandBsonBytes: relevant.reduce((bytes, item) => bytes + BSON.calculateObjectSize(item.command), 0),
    attempts: result.definitions[0]?.outcome.attempts }));
  return result;
}

async function main() {
  const uri = process.env.REDEMEINE_MONGO_URI;
  if (!uri) throw new Error('REDEMEINE_MONGO_URI required (replica set).');
  const commands: CommandStartedEvent[] = [];
  const client = new MongoClient(uri, { monitorCommands: true });
  client.on('commandStarted', (command) => commands.push(command));
  const dbs: Db[] = [];
  const db = () => {
    const value = client.db(`aan1_${randomUUID().replaceAll('-', '')}`);
    dbs.push(value);
    return value;
  };
  try {
    const memory = () => { const store = new InMemoryProjectionStore<State>(); return () => store; };
    const mongo = () => mongoResources(db(), client).makeStore;
    for (const suite of [memory, mongo]) {
      await runRouting(suite());
      await runFirstCandidateWrite(suite()());
      await runNone(suite()());
      await runDisjointAttach(suite());
      for (const kind of ['absent', 'empty', 'member', 'aba'] as const) {
        await runRace(suite(), kind, false);
        await runRace(suite(), kind, true);
      }
    }
    await runRollback(db(), client, commands);
    await runJoinMembershipCutover(db(), client);
    for (const boundSet of [true, false]) {
      for (const recording of [true, false]) await runJoinBinding(db(), client, boundSet, recording);
    }
    await runJoinInvalidRows(db(), client);
    await runJoinReceiptRaces(db(), client);
    for (const fallback of [false, true]) {
      const database = db();
      const store = mongoResources(database, client).makeStore();
      await store.initializeProjectionSourceCommitStore();
      await runMultiEventBatch(store, database.databaseName, commands, fallback);
      for (const concurrent of [false, true]) {
        const { collection, makeStore } = mongoResources(db(), client);
        await runFracturedReadRegression(collection, makeStore, fallback, concurrent);
      }
    }
    for (const count of [1, 32, 256, 1024, 1025]) await runScale(db(), client, commands, count);
    console.log('Join membership scenarios passed in memory and on replica-set MongoDB.');
  } finally {
    for (const database of dbs) await database.dropDatabase();
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
