import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  joinMembershipKey, type CommitProjectionSourceCommitRequest, type JoinSeedProvenance,
  type LoadProjectionSourceCommitSnapshotRequest
} from '@redemeine/projection-runtime-core';
import { BSON, type CommandStartedEvent, type Db, type MongoClient } from 'mongodb';
import { decodeMongoProjectionChangesReceipt, MongoProjectionStore, type MongoProjectionChangesRecord,
  type ProjectionDedupeRecord, type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord } from '../src';
import { injectUnknown } from './realJoinUnknownCommit';

type State = { note: string };
const limit = 16 * 1024 * 1024;

function fixture(db: Db, client: MongoClient, name: string) {
  const views = db.collection<ProjectionDocumentRecord<State>>(`${name}_views`);
  const sets = db.collection<ProjectionJoinMembershipRecord>(`${name}_sets`);
  const progress = db.collection<ProjectionDedupeRecord>(`${name}_progress`);
  const changes = db.collection<MongoProjectionChangesRecord>(`${name}_changes`);
  const { mongoClient, arm } = injectUnknown(client);
  const store = new MongoProjectionStore({ collection: views, joinMembershipCollection: sets,
    linkCollection: db.collection(`${name}_links`), dedupeCollection: progress, changeCollection: changes, mongoClient });
  return { store, views, sets, progress, changes, arm };
}

function plan(name: string, note: string): CommitProjectionSourceCommitRequest<State> {
  const streamId = randomUUID();
  const events = ([0, 1] as const).map((index) => ({
    eventId: randomUUID(), eventIndex: index, streamVersion: index, timestamp: '2026-11-19T00:00:00.000Z',
    aggregateType: 'Order', aggregateId: 'order', type: 'Assign', payload: {}
  })) as [CommitProjectionSourceCommitRequest['commit']['events'][0], CommitProjectionSourceCommitRequest['commit']['events'][0]];
  const proof: JoinSeedProvenance = { aggregateType: 'Order', aggregateId: 'order', documentId: 'order',
    from: 'projection', seedName: 'OrderProjection', seedGeneration: 'g1', position: { kind: 'throughCommit', streamId, commitSequence: -0 } };
  return {
    version: 1, mode: 'atomic-all', projectionName: name, projectionGeneration: 'g1',
    commit: { streamId, commitId: randomUUID(), commitSequence: 0, events },
    finalDocuments: [{ targetDocumentId: 'A', expectedRevision: null, finalDocument: { note: 'done' } }],
    stagedLinks: [], joinSeedVersion: 1,
    joinMembershipFences: [{ aggregateType: 'Order', aggregateId: 'order', expectedRevision: null, targetDocumentIds: ['A'],
      seeds: [{ targetDocumentId: 'A', provenance: proof }] }],
    progress: { strategy: 'own_record', source: { sourceId: streamId, expectedSequence: null, finalSequence: 0 } },
    additionalWrites: [{ kind: 'projection_changes', collection: 'views', targets: [{ targetDocumentId: 'A', transitions: [
      { eventIndex: 0, eventId: events[0].eventId, changeType: 'create', patch: [{ op: 'add', path: '', value: { note } }], joinSeeds: [proof] },
      { eventIndex: 1, eventId: events[1].eventId, changeType: 'update', patch: [{ op: 'replace', path: '/note', value: 'done' }], joinSeeds: [proof] }
    ] }] }]
  };
}

function lookup(request: CommitProjectionSourceCommitRequest): LoadProjectionSourceCommitSnapshotRequest {
  return { projectionName: request.projectionName, projectionGeneration: request.projectionGeneration, targetDocumentIds: [], links: [],
    progressStrategy: 'none', changeIdentity: { collection: 'views', sourceId: request.commit.streamId,
      commitId: request.commit.commitId, commitSequence: request.commit.commitSequence } };
}

async function checkCodec(db: Db, client: MongoClient, legacy: boolean) {
  const name = legacy ? 'legacy_seed_codec' : 'interned_seed_codec';
  const { store, changes, arm, views } = fixture(db, client, name);
  const request = plan(name, 'sample');
  await store.initializeProjectionSourceCommitStore();
  arm({ abort: false, after: async () => {
    const row = await changes.findOne();
    assert(row?.kind === 'projection_changes');
    assert.equal(row.seedEncoding?.descriptors.length, 1);
    assert.deepEqual(row.targets[0]?.transitions.map((t) => t.joinSeedRefs), [[0], [0]]);
    assert(row.targets[0]?.transitions.every((t) => t.joinSeeds === undefined));
    if (legacy) {
      const { _id, outcome } = row;
      await changes.replaceOne({ _id }, { ...decodeMongoProjectionChangesReceipt(row), outcome });
    }
  } });
  const initial = await store.commitProjectionSourceCommit(request);
  assert(initial.status === 'committed' && !initial.replayed);
  assert.deepEqual(initial.additionalWrites?.[0]?.targets[0]?.transitions, request.additionalWrites![0].targets[0]!.transitions);
  assert.deepEqual(initial.linkRevisions, { [joinMembershipKey('Order', 'order')]: 1 });
  const replay = await store.commitProjectionSourceCommit(request);
  assert.deepEqual(replay, { ...initial, replayed: true });
  assert.equal((await store.loadProjectionSourceCommitSnapshot(lookup(request))).changeReceipt, 'committed');
  assert.equal((await views.findOne())?.v2Revision, 1);
  if (!legacy) await checkMalformedReceipt(store, request, changes);
}

async function checkMalformedReceipt(store: MongoProjectionStore<State>, request: CommitProjectionSourceCommitRequest<State>,
  changes: ReturnType<typeof fixture>['changes']) {
  const original = await changes.findOne();
  assert(original?.kind === 'projection_changes');
  for (const [field, bad] of [
    ['targets.0.transitions.0.joinSeedRefs', [999]], ['targets.0.transitions.0.joinSeedRefs', [0.5]],
    ['targets.0.transitions.0.joinSeeds', original.seedEncoding?.descriptors],
    ['seedEncoding.kind', 'unknown-v2'], ['seedEncoding.descriptors.0.position.commitSequence', -1]
  ] as const) {
    await changes.updateOne({ _id: original._id }, { $set: { [field]: bad } });
    await assert.rejects(store.loadProjectionSourceCommitSnapshot(lookup(request)), /Malformed.*seed encoding/);
    await assert.rejects(store.commitProjectionSourceCommit(request), /Malformed.*seed encoding/);
    await changes.replaceOne({ _id: original._id }, original);
  }
}

async function checkBsonLimit(db: Db, client: MongoClient) {
  const name = 'receipt_bson_limit';
  const baseline = fixture(db, client, 'receipt_baseline');
  assert.equal((await baseline.store.commitProjectionSourceCommit(plan(name, ''))).status, 'committed');
  const row = await baseline.changes.findOne();
  assert(row);
  const payload = limit - BSON.serialize(row).length;
  const boundary = fixture(db, client, 'receipt_boundary');
  assert.equal((await boundary.store.commitProjectionSourceCommit(plan(name, 'x'.repeat(payload)))).status, 'committed');
  const sized = await boundary.changes.aggregate([{ $project: { length: { $bsonSize: '$$ROOT' } } }]).next();
  assert.equal(sized?.length, limit);
  const oversized = fixture(db, client, 'receipt_oversized');
  await oversized.store.initializeProjectionSourceCommitStore();
  const mutations: string[] = [];
  const monitor = ({ commandName }: CommandStartedEvent) => {
    if (['insert', 'update', 'delete', 'findAndModify', 'bulkWrite'].includes(commandName)) mutations.push(commandName);
  };
  const excess = plan(name, 'x'.repeat(payload + 1));
  client.on('commandStarted', monitor);
  try {
    const rejected = await oversized.store.commitProjectionSourceCommit(excess);
    assert(rejected.status === 'rejected' && !rejected.retryable);
    assert.match(rejected.reason, /16 MiB physical BSON/);
  } finally { client.off('commandStarted', monitor); }
  assert.deepEqual(mutations, []);
  for (const collection of [oversized.views, oversized.sets, oversized.progress, oversized.changes]) {
    assert.equal(await collection.countDocuments(), 0);
  }
}

export async function checkRealJoinReceiptCodec(db: Db, client: MongoClient) {
  await checkCodec(db, client, false);
  await checkCodec(db, client, true);
  await checkBsonLimit(db, client);
  return { legacyReplayAndUnknown: 'passed', internedReplayAndUnknown: 'passed',
    malformedRejected: true, boundaryBytes: limit, oversizedMutationCommands: 0 };
}
