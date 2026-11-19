import {
  createProjection, projectionUuidToBase64Url22, registerNativeProjectionCaptureSnapshot, sealProjectionCaptureRequest,
  type CommitProjectionSourceCommitRequest, type ProjectionSourceCommit, type ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';
import { changeSnapshotRequest, projectionChangesRequest } from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { reduceProjectionSourceCommit } from '../../projection-worker-core/src/projectionCommitReducer';
import { MongoProjectionStore, type MongoProjectionChangesRecord } from '../src';
import { authoritativeMongoEdits } from '../src/store/sourceCommitStateDelta';
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

function capturedInline(commit: ProjectionSourceCommit, snapshot: ProjectionSourceCommitSnapshot<{ value: number }>) {
  const definition = createProjection('orders', () => ({ value: 0 }))
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, { Changed(draft) { draft.value++; } })
    .identity(() => 'one').deduplication({ strategy: 'in_document' }).buildCommitDefinition();
  const reduction = reduceProjectionSourceCommit(definition, 'g1', commit, snapshot);
  if (reduction.status !== 'planned') throw new Error(`Expected plan: ${JSON.stringify(reduction)}`);
  return reduction.request;
}

test.each([true, false])('single-write lost acknowledgment, applied=%s', async (applied) => {
  const { store, collection, get, request } = await inlineFixture();
  const snapshot = await get();
  const captured = capturedInline(request.commit, snapshot);
  const update = collection.updateOne.bind(collection);
  collection.updateOne = async (filter, updateDoc, options) => {
    expect(options).toMatchObject({ writeConcern: { w: 'majority' } });
    expect(options?.session).toBeUndefined();
    if (applied) await update(filter, updateDoc, options);
    throw new Error('socket closed before acknowledgment');
  };
  const result = await store.commitProjectionSourceCommit(captured, snapshot);
  expect(result).toMatchObject(applied ? { status: 'committed', documentRevisions: { one: 2 } }
    : { status: 'rejected', category: 'transient', reason: 'ambiguous single-document write outcome' });
  expect(await store.load('one')).toMatchObject({ value: applied ? 2 : 1 });
});

test('copied or mutated snapshot metadata cannot authorize a different baseline', async () => {
  const { store, collection, get, request, key } = await inlineFixture();
  const snapshot = await get();
  expect(Object.isFrozen(snapshot.targets[0]?.state)).toBe(false);
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
  expect(collection.sessionLog.at(-1)?.session).toBeDefined();
});

test.each(['copy', 'foreign', 'other-load'] as const)('genuine capture from %s cannot mint local prepared proof', async (origin) => {
  const { store, collection, get, request } = await inlineFixture();
  const local = await get();
  const external = origin === 'foreign' ? await (await inlineFixture()).get()
    : origin === 'other-load' ? await get() : structuredClone(local);
  // Even knowledge of the internal marker and invoking the reducer is not a store-local proof.
  registerNativeProjectionCaptureSnapshot(external);
  const captured = capturedInline(request.commit, external);
  const supplied = origin === 'other-load' ? local : external;
  expect(await store.commitProjectionSourceCommit(captured, supplied)).toMatchObject({ status: 'committed' });
  expect(await store.load('one')).toEqual({ value: 2, kept: 'yes' });
  expect(collection.sessionLog.at(-1)?.session).toBeDefined();
});

test('an independently marked baseline cannot authorize a partial write', async () => {
  const { store, collection, get, request } = await inlineFixture();
  const local = await get();
  const fabricated = { ...local, targets: [{ ...local.targets[0]!, state: { value: 90 } }] };
  registerNativeProjectionCaptureSnapshot(fabricated);
  const captured = capturedInline(request.commit, fabricated);
  expect(await store.commitProjectionSourceCommit(captured, fabricated)).toMatchObject({ status: 'committed' });
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail)
    .toMatchObject({ update: { $set: { state: { value: 91 } } } });
  expect(await store.load('one')).toEqual({ value: 91 });
});

test('raw transactional fallback still honors a same-store observed write identity', async () => {
  const { store, collection, get, request } = await inlineFixture();
  const snapshot = await get();
  await collection.updateOne({ _id: 'one' }, { $set: { state: { value: 7 },
    v2WriteId: '00000000-0000-4000-8000-000000000099' } });
  expect(await store.commitProjectionSourceCommit(request, snapshot)).toMatchObject({ status: 'rejected', category: 'conflict' });
  expect(await store.load('one')).toEqual({ value: 7 });
});

test.each([
  ['revision', { v2Revision: 20 }],
  ['write identity', { v2WriteId: '00000000-0000-4000-8000-000000000099' }],
  ['timestamp', { updatedAt: 'new-legacy-timestamp' }],
  ['checkpoint absence', { checkpoint: { sequence: 99 } }]
] as const)('a prepared native delta is fenced by %s', async (_name, changedFence) => {
  const { store, collection, get, request, key } = await inlineFixture();
  const snapshot = await get();
  const captured = capturedInline(request.commit, snapshot);
  await collection.updateOne({ _id: 'one' }, { $set: { ...changedFence, state: { value: 7 } } });
  expect(await store.commitProjectionSourceCommit(captured, snapshot)).toMatchObject({ status: 'rejected', category: 'conflict' });
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail)
    .toMatchObject({ update: { $set: { 'state.value': 2 } } });
  expect(collection.snapshot()[0]).toMatchObject({ ...changedFence, state: { value: 7 }, sourceProgress: { [key]: 0 } });
});

test('changed BSON-specific values are handled as atomic values, not keyed objects', () => {
  const after = new Date(1000);
  expect(authoritativeMongoEdits({ stamp: new Date(0) }, { stamp: after }))
    .toEqual([{ op: 'replace', path: '/stamp', value: after }]);
});

test.each([[false, false, false], [false, true, false], [true, false, false], [true, true, false], [false, false, true], [true, false, true]])(
  'fresh native load and 32 edits do not scan untouched lines (recording=%s, hook=%s, array edit=%s)', async (recording, hook, arrayEdit) => {
    const initial = { quantity: 0, timestamp: '', lines: Array.from({ length: 32_000 }, (_, lineProbe) => ({ lineProbe, count: 0 })) };
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
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Changed(draft) {
          if (!arrayEdit) { draft.quantity++; return; }
          void draft.lines[0]!.lineProbe;
          draft.lines[1]!.count++;
        }
      })
      .identity(() => 'one').hooks(hook ? { afterEach(draft, event) { draft.timestamp = event.timestamp; } } : {})
      .deduplication({ strategy: 'in_document' }).buildCommitDefinition();

    const descriptor = Object.getOwnPropertyDescriptor;
    const ownKeys = Reflect.ownKeys;
    const entries = Object.entries;
    const isUntouchedLine = (value: object) => {
      const marker = descriptor(value, 'lineProbe')?.value;
      return typeof marker === 'number' && marker > 1;
    };
    let lineVisits = 0;
    let insideFakeWrite = false;
    const updateOne = collection.updateOne.bind(collection);
    collection.updateOne = async (...args) => {
      // The mock clones the full stored row when it applies even a dotted update.
      insideFakeWrite = true;
      try { return await updateOne(...args); } finally { insideFakeWrite = false; }
    };
    Object.getOwnPropertyDescriptor = (value, key) => {
      if (!insideFakeWrite && key === 'lineProbe' && isUntouchedLine(value)) lineVisits++;
      return descriptor(value, key);
    };
    Reflect.ownKeys = (value) => {
      if (!insideFakeWrite && isUntouchedLine(value)) lineVisits++;
      return ownKeys(value);
    };
    Object.entries = (value) => {
      if (!insideFakeWrite && value && typeof value === 'object' && isUntouchedLine(value)) lineVisits++;
      return entries(value);
    };
    try {
      const snapshot = await store.loadProjectionSourceCommitSnapshot({ ...changeSnapshotRequest, links: [],
        progressStrategy: 'in_document', prepareSourceCommit: true, ...(recording ? { changeIdentity: {
          sourceId: commit.streamId, commitId: commit.commitId, commitSequence: 1, collection: 'views'
        } } : {}) });
      expect(lineVisits).toBe(0);
      const result = reduceProjectionSourceCommit(definition, 'g1', commit, snapshot, undefined, recording ? 'views' : undefined);
      if (result.status !== 'planned') throw new Error(`Expected plan: ${JSON.stringify(result)}`);
      expect(result.request.finalDocuments[0]?.finalDocument.lines[2]).toBe(snapshot.targets[0]?.state?.lines[2]);
      if (!arrayEdit) expect(result.request.finalDocuments[0]?.finalDocument.lines).toBe(snapshot.targets[0]?.state?.lines);
      expect(lineVisits).toBe(0);
      expect(await store.commitProjectionSourceCommit(result.request, snapshot)).toMatchObject({ status: 'committed' });
      expect(lineVisits).toBe(0);
      expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail)
        .toMatchObject({ update: { $set: { [arrayEdit ? 'state.lines.1.count' : 'state.quantity']: 32 } } });
      const persisted = await store.load('one');
      expect(arrayEdit ? persisted?.lines[1]?.count : persisted?.quantity).toBe(32);
      expect(changeCollection.snapshot()).toHaveLength(recording ? 1 : 0);
    } finally {
      Object.getOwnPropertyDescriptor = descriptor;
      Reflect.ownKeys = ownKeys;
      Object.entries = entries;
    }
  }
);
