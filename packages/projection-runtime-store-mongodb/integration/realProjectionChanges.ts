import assert from 'node:assert/strict';
import type { Collection, Db, MongoClient } from 'mongodb';
import {
  MongoProjectionStore,
  type MongoProjectionChangesRecord,
  type ProjectionDedupeRecord,
  type ProjectionDocumentRecord,
  type ProjectionLinkRecord
} from '../src';
import type { CommitProjectionSourceCommitRequest } from '@redemeine/projection-runtime-core';
import { createProjection } from '@redemeine/projection-runtime-core';
import {
  invalidChangeMetadataRequests, serializerLikeTargetIds, withSerializerLikeTargetIds, withUnicodeChangeMetadata
} from '../../projection-runtime-core/test/projectionChangeMetadataFixtures';
import { executeProjectionDefinition } from '../../projection-worker-core/src/projectionDefinitionExecutor';
import { createProjectionLaneScheduler } from '../../projection-worker-core/src/targetLaneScheduler';
import { checkRealNoneProjectionChanges } from './realNoneProjectionChanges';

type State = { value: number; kept: boolean };
const sourceId = '00000000-0000-4000-8000-000000000001';

function changeRequest(sequence: number): CommitProjectionSourceCommitRequest<State> {
  const commitId = `00000000-0000-4000-8000-${String(sequence + 20).padStart(12, '0')}`;
  const eventId = `00000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}`;
  const finalDocument = { value: sequence + 1, kept: true };
  return {
    version: 1, mode: 'atomic-all', projectionName: 'feed', projectionGeneration: 'g1',
    commit: { streamId: sourceId, commitId, commitSequence: sequence, events: [{
      eventIndex: 0, eventId, streamVersion: sequence, aggregateType: 'Order', aggregateId: 'a',
      type: 'Changed', payload: {}, timestamp: '2026-09-22T00:00:00.000Z'
    }] },
    finalDocuments: [{ targetDocumentId: 'one', expectedRevision: sequence || null, finalDocument }],
    stagedLinks: sequence === 0 ? [] : [{
      operation: 'subscribe', targetDocumentId: 'one', aggregateType: 'Detail',
      aggregateId: `link-${sequence}`, expectedRevision: null
    }],
    progress: { strategy: 'own_record', source: { sourceId, expectedSequence: sequence === 0 ? null : sequence - 1, finalSequence: sequence } },
    additionalWrites: [{ kind: 'projection_changes', collection: 'feed_views', targets: [{ targetDocumentId: 'one', transitions: [{
      eventId, eventIndex: 0, changeType: sequence === 0 ? 'create' : 'update',
      patch: sequence === 0 ? [{ op: 'add', path: '', value: finalDocument }] : [{ op: 'replace', path: '/value', value: sequence + 1 }]
    }] }] }]
  };
}

async function checkPortableState(store: MongoProjectionStore<State>): Promise<void> {
  const first = changeRequest(0);
  const append = first.additionalWrites![0];
  const target = append.targets[0]!;
  for (const reference of [{ $ref: 'links', $id: 'id' }, { _bsontype: 'ObjectId' }, { ['key\0']: 1 }, { surrogate: '\ud800' }]) {
    const finalDocument = { value: 1, kept: true, reference };
    const result = await store.commitProjectionSourceCommit({
      ...first, finalDocuments: [{ ...first.finalDocuments[0]!, finalDocument }],
      additionalWrites: [{ ...append, targets: [{ ...target, transitions: [{
        ...target.transitions[0]!, patch: [{ op: 'add', path: '', value: finalDocument }]
      }] }] }]
    });
    if (result.status !== 'rejected') throw new Error('expected non-portable JSON rejection');
    assert.equal(result.category, 'terminal');
    assert.match(result.reason, /portable JSON/);
  }
  assert.equal(await store.load('one'), null);
}

async function checkPortableMetadata(db: Db, mongoClient: MongoClient): Promise<void> {
  const collection = db.collection<ProjectionDocumentRecord<State>>('metadata_views');
  const linkCollection = db.collection<ProjectionLinkRecord>('metadata_links');
  const dedupeCollection = db.collection<ProjectionDedupeRecord>('metadata_dedupe');
  const changeCollection = await db.createCollection<MongoProjectionChangesRecord>('metadata_feed');
  const store = new MongoProjectionStore({ collection, linkCollection, dedupeCollection, changeCollection, mongoClient });
  for (const [name, malformed] of invalidChangeMetadataRequests(changeRequest(0))) {
    const result = await store.commitProjectionSourceCommit(malformed);
    assert.equal(result.status, 'rejected', name);
    if (result.status !== 'rejected') throw new Error(`accepted ${name}`);
    assert.equal(result.category, 'terminal', name);
    assert.match(result.reason, /metadata|keys collide/, name);
  }
  for (const persisted of [collection, linkCollection, dedupeCollection, changeCollection]) assert.equal(await persisted.countDocuments(), 0);
  const unicode = withUnicodeChangeMetadata(changeRequest(0));
  const first = await store.commitProjectionSourceCommit(unicode);
  assert.equal(first.status, 'committed');
  assert.deepEqual(await store.commitProjectionSourceCommit(unicode), first);
  const receipt = await changeCollection.findOne();
  assert.equal(receipt?.collection, 'order_🧾_e\u0301');
  assert.equal(receipt?.projectionName, '注文📦');
  assert.ok(receipt && 'documentRevisionEntries' in receipt.outcome);
  assert.deepEqual(receipt.outcome.documentRevisionEntries, [['ticket_🎫_cafe\u0301', 1]]);
  assert.deepEqual(receipt.outcome.linkRevisionEntries, [['注文:関連🌐', 1]]);

  if (first.status !== 'committed') throw new Error('expected committed Unicode metadata');
  const { documentRevisions, linkRevisions, progress } = first;
  await changeCollection.updateOne({ _id: receipt._id }, { $set: { outcome: { documentRevisions, linkRevisions, progress } } });
  assert.deepEqual(await store.commitProjectionSourceCommit(unicode), first, 'older raw-map receipt must still replay');
  await checkSerializerLikeTargetIds(store, changeCollection);
}

async function checkSerializerLikeTargetIds(
  store: MongoProjectionStore<State>, rows: Collection<MongoProjectionChangesRecord>
): Promise<void> {
  const request = withSerializerLikeTargetIds(changeRequest(0));
  const first = await store.commitProjectionSourceCommit(request);
  assert.equal(first.status, 'committed');
  if (first.status !== 'committed') throw new Error('expected committed special target IDs');
  assert.deepEqual(await store.commitProjectionSourceCommit(request), first);
  const stored = await rows.findOne({ projectionGeneration: request.projectionGeneration });
  assert.ok(stored && 'documentRevisionEntries' in stored.outcome);
  assert.deepEqual(stored.outcome.documentRevisionEntries, serializerLikeTargetIds.map((id) => [id, 1]));
  assert.equal(Object.getPrototypeOf(first.documentRevisions), Object.prototype);
  for (const id of serializerLikeTargetIds) {
    assert.equal(Object.getOwnPropertyDescriptor(first.documentRevisions, id)?.value, 1);
    assert.deepEqual(await store.load(id), { value: 1, kept: true });
  }
}

async function checkWorkerRejection(store: MongoProjectionStore<State>): Promise<void> {
  const definition = createProjection('feed', () => ({ value: 0, kept: true }))
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
      Changed: (state) => { state.value = 99; }
    })
    .identity(() => 'one').deduplication({ strategy: 'own_record' }).buildCommitDefinition();
  const options = { definition, generation: 'g1', projectionChanges: 'feed_views', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 1 };
  const { commit } = changeRequest(2);
  for (const _attempt of [1, 2]) {
    const result = await executeProjectionDefinition(options, commit);
    assert.equal(result.status, 'terminal');
    if (result.status !== 'terminal') throw new Error('expected a terminal validation failure');
    assert.match(result.reason, /document validation, code 121/);
  }
}

export async function checkRealProjectionChanges(db: Db, mongoClient: MongoClient): Promise<void> {
  await checkPortableMetadata(db, mongoClient);
  await checkRealNoneProjectionChanges(db, mongoClient, changeRequest(0).commit);
  const collection = db.collection<ProjectionDocumentRecord<State>>('feed_views');
  const linkCollection = db.collection<ProjectionLinkRecord>('feed_links');
  const dedupeCollection = db.collection<ProjectionDedupeRecord>('feed_dedupe');
  const changeCollection = await db.createCollection<MongoProjectionChangesRecord>('projection_changes', {
    validator: { commitSequence: { $lt: 2 } }
  });
  const store = new MongoProjectionStore({ collection, linkCollection, dedupeCollection, changeCollection, mongoClient });
  await checkPortableState(store);
  assert.equal(await changeCollection.countDocuments(), 0);
  assert.equal(await dedupeCollection.countDocuments(), 0);
  assert.equal((await store.commitProjectionSourceCommit(changeRequest(0))).status, 'committed');
  const second = changeRequest(1);
  const result = await store.commitProjectionSourceCommit(second);
  assert.equal(result.status, 'committed');
  assert.deepEqual(await store.commitProjectionSourceCommit(second), result);
  assert.equal(await changeCollection.countDocuments(), 2);
  const persisted = await changeCollection.findOne({ commitSequence: 1 });
  assert.ok(persisted);
  const { _id, outcome, ...record } = persisted;
  assert.equal(_id, record.resumeToken);
  if (result.status !== 'committed') throw new Error('expected a durable receipt');
  assert.deepEqual(result.additionalWrites, [record]);
  const snapshot = await store.loadProjectionSourceCommitSnapshot({
    projectionName: second.projectionName, projectionGeneration: second.projectionGeneration, progressStrategy: 'none',
    targetDocumentIds: ['one'], links: [], changeIdentity: {
      sourceId, commitId: second.commit.commitId, commitSequence: 1, collection: record.collection
    }
  });
  assert.equal(snapshot.changeReceipt, 'committed');

  const before = await collection.findOne({ _id: 'one' });
  assert.deepEqual(before?.state, { value: 2, kept: true });
  assert.equal(before?.v2Revision, 2);
  assert.match(JSON.stringify(await store.commitProjectionSourceCommit(changeRequest(2))), /"category":"terminal".*code 121/);
  await checkWorkerRejection(store);
  assert.deepEqual(await collection.findOne({ _id: 'one' }), before);
  assert.equal(await linkCollection.countDocuments(), 1);
  assert.equal((await dedupeCollection.findOne({ sourceId }))?.commitSequence, 1);
  assert.equal(await changeCollection.countDocuments(), 2);

  const first = changeRequest(0);
  assert.equal((await store.commitProjectionSourceCommit(first)).status, 'committed');
  assert.equal((await store.commitProjectionSourceCommit({ ...first, commit: { ...first.commit, commitId: second.commit.commitId } })).status, 'rejected');
  await changeCollection.deleteOne({ commitSequence: 0 });
  assert.match(JSON.stringify(await store.commitProjectionSourceCommit(first)), /"category":"terminal".*Missing projection_changes history/);

  const empty: typeof first = {
    ...first, projectionGeneration: 'empty', finalDocuments: [],
    additionalWrites: [{ ...first.additionalWrites![0], targets: [] }]
  };
  const emptyResult = await store.commitProjectionSourceCommit(empty);
  assert.equal(emptyResult.status, 'committed');
  assert.equal(await changeCollection.countDocuments({ kind: 'projection_changes_empty' }), 1);
  assert.equal(await changeCollection.countDocuments({ kind: 'projection_changes' }), 1);
  assert.deepEqual(await store.commitProjectionSourceCommit(empty), emptyResult);
}
