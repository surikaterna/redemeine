import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  joinMembershipKey, type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import { MongoProjectionStore, type MongoProjectionChangesRecord, type MongoProjectionStoreOptions,
  type ProjectionJoinMembershipRecord } from '@redemeine/projection-runtime-store-mongodb';
import type { Db, MongoClient } from 'mongodb';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, path, type State, turn } from './joinMembershipFixture';

type Phase = 'initial' | 'full' | 'compat-full' | 'fallback-write';
type Proof = 'match' | 'empty' | 'missing' | 'mismatch' | 'unavailable' | 'none' | 'off' | 'fresh';
const key = joinMembershipKey('boards', 'set-generation', path.aggregateType, path.aggregateId);

async function receiptRace(db: Db, client: MongoClient, phase: Phase, proof: Proof) {
  const suffix = `${phase}-${proof}`;
  const views = db.collection(`receipt-views-${suffix}`);
  const receipts = db.collection<MongoProjectionChangesRecord>(`receipt-changes-${suffix}`);
  const sets = db.collection<ProjectionJoinMembershipRecord>(`receipt-sets-${suffix}`);
  const progress = db.collection(`receipt-progress-${suffix}`);
  const storeOptions: Omit<MongoProjectionStoreOptions<State>, 'changeCollection'> = {
    mongoClient: client, collection: db.collection(views.collectionName), joinMembershipCollection: sets,
    linkCollection: db.collection(`receipt-scalar-${suffix}`), dedupeCollection: db.collection(progress.collectionName) };
  const strategy = proof === 'none' ? { strategy: 'none' as const, reason: 'fixture', duplicateEffects: 'acknowledged' as const }
    : { strategy: 'own_record' as const };
  const optionsFor = (store: ProjectionSourceCommitStorePort<State>) => {
    const options = fixtureOptions(store, [], strategy);
    if (proof !== 'off') return options;
    const { projectionChanges: _recording, ...entry } = options.manifest.definitions[0]!;
    const { projectionChanges: _runtime, ...definition } = options.definitions[0]!;
    return { ...options, definitions: [definition], manifest: { ...options.manifest, definitions: [entry] } };
  };
  await sets.insertOne({ _id: key, ...path, format: 'set-v1', revision: 0, targetDocumentIds: ['A', 'B'] });
  const event = turn(randomUUID(), 0, orderId, [['ordinary']]);
  const winnerOptions = optionsFor(new MongoProjectionStore({ ...storeOptions, changeCollection: receipts }));
  const winner = coordinator({ ...winnerOptions, sourceOrder: { ...winnerOptions.sourceOrder,
    async advanceCoverage() { throw new Error('interrupted before advancing coverage'); } } });

  let disrupted = false;
  let proofReads = 0;
  let totalReads = 0;
  const raw = new MongoProjectionStore<State>({ ...storeOptions, changeCollection: {
    updateOne: receipts.updateOne.bind(receipts),
    async findOne(filter, readOptions) {
      totalReads++;
      if (disrupted) {
        proofReads++;
        if (proof === 'unavailable') throw new Error('injected receipt read outage');
      }
      return receipts.findOne(filter, readOptions);
    }
  } });
  async function disrupt() {
    if (proof === 'fresh') return;
    if (proof === 'empty') await sets.updateOne({ _id: key }, { $set: { targetDocumentIds: [] }, $inc: { revision: 1 } });
    if (proof !== 'missing' && proof !== 'off') {
      const result = await winner.process(event);
      assert.equal(result.definitions[0]?.outcome.status, 'committed');
      assert.equal(await fixtureCoverage(winnerOptions, event), null);
    }
    if (proof === 'mismatch') await receipts.updateOne({}, { $set: { commitId: randomUUID() } });
    await sets.updateOne({ _id: key }, { $set: { targetDocumentIds: ['B', 'A'] } });
    disrupted = true;
  }
  let loads = 0;
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: raw.joinMembershipCapability, projectionChangesCapability: raw.projectionChangesCapability,
    ...(phase === 'compat-full' || phase === 'fallback-write' ? {} : { sourceCommitSnapshotCapability: raw.sourceCommitSnapshotCapability }),
    async loadProjectionSourceCommitSnapshot(request) {
      if (request.joinMembership && ++loads === (phase === 'initial' ? 1 : phase.endsWith('full') ? 2 : -1)) await disrupt();
      return raw.loadProjectionSourceCommitSnapshot(request);
    },
    async commitProjectionSourceCommit(request, snapshot) {
      if (phase === 'fallback-write') await disrupt();
      const readsBeforeCommit = totalReads;
      const result = await raw.commitProjectionSourceCommit(request, snapshot);
      if (proof === 'fresh') assert.equal(totalReads, readsBeforeCommit, 'fresh writes must not probe receipts');
      return result;
    }
  };
  const options = optionsFor(port);
  const result = await coordinator(options).process(event);
  const outcome = result.definitions[0]?.outcome;
  const completed = proof === 'match' || proof === 'empty' || proof === 'fresh';
  assert.equal(result.status, completed ? 'completed' : proof === 'unavailable' ? 'retryable' : 'terminal', JSON.stringify(result));
  assert.equal(await fixtureCoverage(options, event), completed ? 0 : null);
  if (proof === 'match' || proof === 'empty') assert.equal(outcome?.status, 'deduplicated');
  const reason = 'reason' in result ? result.reason : '';
  if (proof === 'mismatch') assert.match(reason, /identity mismatch/);
  if (proof === 'missing' || proof === 'none' || proof === 'off') assert.match(reason, /sorted, unique/);
  if (proof === 'fresh') assert.equal(outcome?.status, 'committed');
  assert.equal(proofReads, ['none', 'off', 'fresh'].includes(proof) ? 0 : 1);
  if (proof === 'none' || proof === 'off') assert.equal(totalReads, 0);
  // Compatibility still reads receipts in its two snapshots, before the write path.
  if (proof === 'fresh') assert.equal(totalReads, phase === 'fallback-write' ? 2 : 0);
  const winnerWrote = !['missing', 'off'].includes(proof);
  assert.equal(await progress.countDocuments(), winnerWrote && proof !== 'none' ? 1 : 0);
  assert.equal(await receipts.countDocuments(), winnerWrote ? 1 : 0);
  assert.deepEqual((await views.find().sort({ _id: 1 }).toArray()).map(({ state }) => state.visits),
    winnerWrote && proof !== 'empty' ? [['ordinary'], ['ordinary']] : []);
  console.log(JSON.stringify({ scenario: 'membership-receipt-race', phase, proof, status: result.status, proofReads, totalReads }));
}

async function invalidAttachDoesNotProbeReceipts(db: Db, client: MongoClient) {
  const views = db.collection('invalid-attach-views');
  const sets = db.collection<ProjectionJoinMembershipRecord>('invalid-attach-sets');
  const progress = db.collection('invalid-attach-progress');
  const receipts = db.collection<MongoProjectionChangesRecord>('invalid-attach-changes');
  let reads = 0;
  const store = new MongoProjectionStore<State>({ mongoClient: client, collection: db.collection(views.collectionName),
    joinMembershipCollection: sets, linkCollection: db.collection('invalid-attach-scalar'),
    dedupeCollection: db.collection(progress.collectionName), changeCollection: {
      updateOne: receipts.updateOne.bind(receipts),
      async findOne() { reads++; throw new Error('invalid attach must not become ambiguous'); }
    } });
  const options = fixtureOptions(store);
  const event = turn(randomUUID(), 0, 'A', [['attach', { order: '\ud83d' }]], 'Board');
  const result = await coordinator(options).process(event);
  assert.equal(result.status, 'terminal', JSON.stringify(result));
  assert.match(result.reason, /well-formed Unicode/);
  assert.equal(reads, 0);
  assert.equal(await fixtureCoverage(options, event), null);
  assert.deepEqual(await Promise.all([views.countDocuments(), sets.countDocuments(), progress.countDocuments(), receipts.countDocuments()]), [0, 0, 0, 0]);
}

export async function runJoinReceiptRaces(db: Db, client: MongoClient) {
  for (const phase of ['initial', 'full', 'compat-full', 'fallback-write'] as const) await receiptRace(db, client, phase, 'match');
  for (const proof of ['missing', 'mismatch', 'unavailable', 'none', 'off', 'fresh'] as const) await receiptRace(db, client, 'full', proof);
  for (const proof of ['empty', 'missing', 'mismatch', 'unavailable', 'none', 'off', 'fresh'] as const) await receiptRace(db, client, 'fallback-write', proof);
  await invalidAttachDoesNotProbeReceipts(db, client);
}
