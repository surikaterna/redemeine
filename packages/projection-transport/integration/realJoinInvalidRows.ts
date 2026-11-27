import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { joinMembershipKey, type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import type { Db, Document, MongoClient } from 'mongodb';
import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, path, routed, type State, turn } from './joinMembershipFixture';

const scope = { projectionName: 'boards', projectionGeneration: 'set-generation' };
const key = joinMembershipKey(scope.projectionName, scope.projectionGeneration, path.aggregateType, path.aggregateId);
const valid = { _id: key, ...path, format: 'set-v1', targetDocumentIds: ['A', 'B'], revision: 0 };
type Phase = 'initial' | 'turn' | 'fallback-turn' | 'retry' | 'fallback-write';

function resources(db: Db, client: MongoClient, phase: string) {
  const sets = db.collection<Document & { _id: string }>(`${phase}_sets`);
  const views = db.collection(`${phase}_views`);
  const progress = db.collection(`${phase}_progress`);
  const changes = db.collection(`${phase}_changes`);
  const store = new MongoProjectionStore<State>({ mongoClient: client, joinMembershipCollection: db.collection(sets.collectionName),
    collection: db.collection(views.collectionName), linkCollection: db.collection(`${phase}_scalar`),
    dedupeCollection: db.collection(progress.collectionName), changeCollection: db.collection(changes.collectionName) });
  return { store, sets, views, progress, changes,
    noWrites: async () => assert.deepEqual(await Promise.all([views.countDocuments(), progress.countDocuments(), changes.countDocuments()]), [0, 0, 0]) };
}

async function corruptAtPhase(db: Db, client: MongoClient, phase: Phase) {
  const ctx = resources(db, client, phase);
  await ctx.store.initializeProjectionSourceCommitStore();
  await ctx.sets.insertOne(valid);
  const broken = { ...valid, targetDocumentIds: ['B', 'A'] };
  const corrupt = async () => { await ctx.sets.replaceOne({ _id: key }, broken); };
  let reads = 0;
  let writes = 0;
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: ctx.store.joinMembershipCapability, projectionChangesCapability: ctx.store.projectionChangesCapability,
    ...(phase.startsWith('fallback') ? {} : { sourceCommitSnapshotCapability: ctx.store.sourceCommitSnapshotCapability }),
    async loadProjectionSourceCommitSnapshot(request) {
      if (request.joinMembership && ++reads === ({ initial: 1, turn: 2, 'fallback-turn': 2, retry: 3, 'fallback-write': -1 })[phase]) {
        await corrupt();
      }
      return ctx.store.loadProjectionSourceCommitSnapshot(request);
    },
    async commitProjectionSourceCommit(request, snapshot) {
      writes++;
      if (phase === 'fallback-write' && writes === 1) await corrupt();
      if (phase === 'retry' && writes === 1) return { version: 1, status: 'rejected', category: 'conflict', retryable: true, reason: 'test OCC' };
      return ctx.store.commitProjectionSourceCommit(request, snapshot);
    }
  };
  const source = randomUUID();
  const first = turn(source, 0, orderId, [['ordinary']]);
  const next = turn(source, 1, 'different-key', [['ordinary']]);
  const options = fixtureOptions(port, [first, next]);
  const runtime = coordinator(options);
  // Later delivery must recover sequence zero first and must not advance when the recovered turn is corrupt.
  const result = await runtime.process(next);
  assert.equal(result.status, 'terminal', JSON.stringify(result));
  assert.match(result.reason, /sorted, unique/);
  assert.deepEqual(result.processedSequences, []);
  assert.equal(await fixtureCoverage(options, first), null);
  await ctx.noWrites();
  assert.deepEqual(await ctx.sets.findOne({ _id: key }), broken);
  await ctx.sets.replaceOne({ _id: key }, valid);
  assert.deepEqual((await runtime.process(next)).processedSequences, [0, 1]);
  assert.equal(await fixtureCoverage(options, first), 1);
  console.log(JSON.stringify({ scenario: 'persisted-corrupt-row', phase, status: result.status, repaired: true }));
}

async function badIdentifiers(db: Db, client: MongoClient, recording: boolean) {
  const ctx = resources(db, client, `unicode-${recording}`);
  const options = fixtureOptions(ctx.store);
  const { projectionChanges: _changes, ...entry } = options.manifest.definitions[0]!;
  const { projectionChanges: _runtimeChanges, ...definition } = options.definitions[0]!;
  const runtime = coordinator(recording ? options : { ...options, definitions: [definition],
    manifest: { ...options.manifest, definitions: [entry] } });
  const source = randomUUID();
  const malformed = '\ud83d';
  const result = await runtime.process(turn(source, 0, orderId, [[routed, { targets: [malformed, '\ue000'], to: malformed }]]));
  assert.equal(result.status, 'terminal', JSON.stringify(result));
  assert.match(result.reason, /well-formed Unicode/);
  assert.equal(await ctx.sets.countDocuments(), 0);
  await ctx.noWrites();
  const healthy = await runtime.process(turn(source, 0, orderId, [[routed, { targets: ['😀', '\ue000'], attachAll: true }]]));
  assert.equal(healthy.status, 'completed', JSON.stringify(healthy));
  assert.deepEqual((await ctx.sets.findOne({ _id: key }))?.targetDocumentIds, ['😀', '\ue000']);
  console.log(JSON.stringify({ scenario: 'unicode-write-guard', recording, status: result.status, healthy: healthy.status }));
}

export async function runJoinInvalidRows(db: Db, client: MongoClient) {
  for (const phase of ['initial', 'turn', 'fallback-turn', 'retry', 'fallback-write'] as const) await corruptAtPhase(db, client, phase);
  for (const recording of [true, false]) await badIdentifiers(db, client, recording);
  const ctx = resources(db, client, 'transient');
  await ctx.store.initializeProjectionSourceCommitStore();
  await client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['find'], errorCode: 50 } });
  const runtime = coordinator(fixtureOptions(ctx.store));
  const input = turn(randomUUID(), 0, orderId, [['ordinary']]);
  const transient = await runtime.process(input);
  assert.equal(transient.status, 'retryable');
  assert.equal(transient.definitions[0]?.outcome.status, 'transient');
  assert.equal((await runtime.process(input)).status, 'completed');
}
