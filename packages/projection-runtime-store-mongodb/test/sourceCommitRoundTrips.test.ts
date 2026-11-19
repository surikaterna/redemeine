import {
  createProjection, projectionUuidToBase64Url22, sealProjectionCaptureRequest,
  type CommitProjectionSourceCommitRequest, type ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import { changeSnapshotRequest, projectionChangesRequest } from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { reduceProjectionSourceCommit } from '../../projection-worker-core/src/projectionCommitReducer';
import { MongoProjectionStore, type MongoProjectionChangesRecord } from '../src';
import {
  createFakeMongoClient, createProjectionDedupeCollection, createProjectionDocumentCollection,
  createProjectionLinkCollection, InMemoryMongoCollection
} from './mocks';

async function inlineFixture() {
  const collection = createProjectionDocumentCollection<{ value: number }>();
  const changeCollection = new InMemoryMongoCollection<MongoProjectionChangesRecord>();
  const store = new MongoProjectionStore({ collection, changeCollection, linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient() });
  const { additionalWrites: _history, ...first } = projectionChangesRequest();
  const key = projectionUuidToBase64Url22(first.commit.streamId);
  const inline = (sequence: number): CommitProjectionSourceCommitRequest<{ value: number }> => {
    const { additionalWrites: _ignored, ...request } = projectionChangesRequest(sequence);
    return { ...request, stagedLinks: [], progress: { strategy: 'in_document', targets: [{
      targetDocumentId: 'one', expected: sequence ? { [key]: sequence - 1 } : {}, final: { [key]: sequence }
    }] } };
  };
  expect((await store.commitProjectionSourceCommit(inline(0))).status).toBe('committed');
  const request = inline(1);
  const get = (recording = false) => store.loadProjectionSourceCommitSnapshot({ ...changeSnapshotRequest,
    links: [], progressStrategy: 'in_document', prepareSourceCommit: true, ...(recording ? { changeIdentity: {
      sourceId: request.commit.streamId, commitId: request.commit.commitId, commitSequence: 1, collection: 'views'
    } } : {}) });
  return { store, collection, changeCollection, get, request, key };
}

test.each([true, false])('single-write lost acknowledgment, applied=%s', async (applied) => {
  const { store, collection, get, request } = await inlineFixture();
  const snapshot = await get();
  const update = collection.updateOne.bind(collection);
  collection.updateOne = async (filter, updateDoc, options) => {
    expect(options).toMatchObject({ writeConcern: { w: 'majority' } });
    expect(options?.session).toBeUndefined();
    if (applied) await update(filter, updateDoc, options);
    throw new Error('socket closed before acknowledgment');
  };
  const result = await store.commitProjectionSourceCommit(request, snapshot);
  expect(result).toMatchObject(applied ? { status: 'committed', documentRevisions: { one: 2 } }
    : { status: 'rejected', category: 'transient', reason: 'ambiguous single-document write outcome' });
  expect(await store.load('one')).toMatchObject({ value: applied ? 2 : 1 });
});

test('copied or mutated snapshot metadata cannot authorize a different baseline', async () => {
  const { store, collection, get, request, key } = await inlineFixture();
  const snapshot = await get();
  expect(Object.isFrozen(snapshot.targets[0]?.state)).toBe(true);
  if (request.progress.strategy !== 'in_document') throw new Error('Expected inline progress');
  const target = request.progress.targets[0]!;
  const forged = { ...request, progress: { ...request.progress, targets: [{ ...target, expected: { [key]: 99 } }] } };
  (snapshot.targets[0]!.sourceProgress as Record<string, number>)[key] = 99;
  expect(await store.commitProjectionSourceCommit(forged, snapshot)).toMatchObject({ status: 'rejected', category: 'conflict' });
  expect(await store.commitProjectionSourceCommit(request, structuredClone(snapshot))).toMatchObject({ status: 'committed' });
  expect(collection.sessionLog.at(-1)?.session).toBeDefined();
});

test.each([false, true])('sealing caller-supplied noop hints is not a proof (recording=%s)', async (recording) => {
  const { store, collection, changeCollection, get, request } = await inlineFixture();
  const snapshot = await get(recording);
  const transitions = [{ eventId: request.commit.events[0].eventId, eventIndex: 0, changeType: 'noop' as const, patch: [] }];
  const forged = sealProjectionCaptureRequest({
    ...request, finalDocuments: [{ ...request.finalDocuments[0]!, finalDocument: { value: 23 },
      statePatch: { kind: 'ordered', transitions } }],
    ...(recording ? { additionalWrites: [{ kind: 'projection_changes', collection: 'views',
      targets: [{ targetDocumentId: 'one', transitions }] }] } : {})
  });
  const result = await store.commitProjectionSourceCommit(forged, snapshot);
  expect(changeCollection.snapshot()).toEqual([]);
  if (recording) {
    expect(result).toMatchObject({ status: 'rejected', category: 'terminal' });
    expect(await store.load('one')).toMatchObject({ value: 1 });
    return;
  }
  expect(result).toMatchObject({ status: 'committed' });
  expect(await store.load('one')).toEqual({ value: 23 });
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail)
    .toMatchObject({ update: { $set: { state: { value: 23 } } } });
});

test.each([[false, false], [false, true], [true, false], [true, true]])(
  'fresh native load seals once; 32 scalar edits do not revisit lines (recording=%s, hook=%s)', async (recording, hook) => {
    const initial = { quantity: 0, timestamp: '', lines: Array.from({ length: 32_000 }, (_, lineProbe) => ({ lineProbe })) };
    const collection = createProjectionDocumentCollection<typeof initial>();
    const changeCollection = new InMemoryMongoCollection<MongoProjectionChangesRecord>();
    const store = new MongoProjectionStore({ collection, changeCollection, linkCollection: createProjectionLinkCollection(),
      dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient() });
    const base = projectionChangesRequest(1).commit;
    const commit = { ...base, events: Array.from({ length: 32 }, (_, eventIndex) => ({
      ...base.events[0], eventIndex, eventId: `event-${eventIndex}`, timestamp: `time-${eventIndex}`
    })) as unknown as ProjectionSourceCommit['events'] };
    await collection.updateOne({ _id: 'one' }, { $set: { state: initial, updatedAt: 'seed', v2Revision: 1,
      v2WriteId: base.commitId, sourceProgress: { [projectionUuidToBase64Url22(base.streamId)]: 0 } } }, { upsert: true });
    await store.initializeProjectionSourceCommitStore();
    const definition = createProjection('orders', () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, { Changed(draft) { draft.quantity++; } })
      .identity(() => 'one').hooks(hook ? { afterEach(draft, event) { draft.timestamp = event.timestamp; } } : {})
      .deduplication({ strategy: 'in_document' }).buildCommitDefinition();

    const descriptor = Object.getOwnPropertyDescriptor;
    let lineVisits = 0;
    Object.getOwnPropertyDescriptor = (value, key) => {
      if (key === 'lineProbe') lineVisits++;
      return descriptor(value, key);
    };
    try {
      const snapshot = await store.loadProjectionSourceCommitSnapshot({ ...changeSnapshotRequest, links: [],
        progressStrategy: 'in_document', prepareSourceCommit: true, ...(recording ? { changeIdentity: {
          sourceId: commit.streamId, commitId: commit.commitId, commitSequence: 1, collection: 'views'
        } } : {}) });
      expect(lineVisits).toBe(32_000);
      const result = reduceProjectionSourceCommit(definition, 'g1', commit, snapshot, undefined, recording ? 'views' : undefined);
      if (result.status !== 'planned') throw new Error(`Expected plan: ${JSON.stringify(result)}`);
      expect(result.request.finalDocuments[0]?.finalDocument.lines).toBe(snapshot.targets[0]?.state?.lines);
      expect(lineVisits).toBe(32_000);
      expect(await store.commitProjectionSourceCommit(result.request, snapshot)).toMatchObject({ status: 'committed' });
      expect(lineVisits).toBe(32_000);
      expect((await store.load('one'))?.quantity).toBe(32);
      expect(changeCollection.snapshot()).toHaveLength(recording ? 1 : 0);
    } finally {
      Object.getOwnPropertyDescriptor = descriptor;
    }
  }
);
