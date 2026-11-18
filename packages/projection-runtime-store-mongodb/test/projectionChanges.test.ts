import { projectionChangesResumeToken, type CommitProjectionSourceCommitRequest } from '@redemeine/projection-runtime-core';
import {
  changeSnapshotRequest,
  defineProjectionChangesStoreConformance,
  projectionChangesRequest
} from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { MongoProjectionStore, type MongoProjectionChangesRecord } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection,
  InMemoryMongoCollection
} from './mocks';

function fixtures(client = createFakeMongoClient()) {
  const collection = createProjectionDocumentCollection<{ value: number; kept?: string }>();
  const linkCollection = createProjectionLinkCollection();
  const dedupeCollection = createProjectionDedupeCollection();
  const changeCollection = new InMemoryMongoCollection<MongoProjectionChangesRecord>();
  const options = { collection, linkCollection, dedupeCollection, changeCollection, mongoClient: client };
  const store = new MongoProjectionStore(options);
  return { store, options, collection, linkCollection, dedupeCollection, changeCollection,
    records: () => changeCollection.snapshot().filter((row) => row.kind === 'projection_changes')
      .map(({ _id, outcome, ...change }) => change) };
}

defineProjectionChangesStoreConformance('Mongo', fixtures);

test('requires a configured change collection only for opted-in source commits', async () => {
  const { options: { changeCollection, ...options } } = fixtures();
  const store = new MongoProjectionStore(options);
  const first = projectionChangesRequest();
  expect(await store.commitProjectionSourceCommit(first)).toMatchObject({
    status: 'rejected', category: 'terminal', reason: 'projection_changes collection is not configured'
  });
  expect(options.collection.snapshot()).toEqual([]);
  const { additionalWrites, ...optedOut } = first;
  expect(await store.commitProjectionSourceCommit(optedOut)).toMatchObject({ status: 'committed' });
});

test('a late append failure rolls back a compiled delta, links and own-record progress', async () => {
  const { store, collection, linkCollection, dedupeCollection, changeCollection } = fixtures();
  const first = projectionChangesRequest();
  expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
  const second = projectionChangesRequest(1);
  type Request = typeof second;
  const next: Request = {
    ...second,
    stagedLinks: [{ ...first.stagedLinks[0]!, operation: 'unsubscribe', expectedRevision: 1 }],
    progress: { strategy: 'own_record', source: { sourceId: second.commit.streamId, expectedSequence: null, finalSequence: 1 } }
  };
  changeCollection.failNextUpdateForId(projectionChangesResumeToken(next), Object.assign(new Error('BSONObj size is invalid'), {
    name: 'MongoServerError', code: 10334
  }));
  expect(await store.commitProjectionSourceCommit(next)).toMatchObject({ status: 'rejected', category: 'terminal' });
  expect(collection.snapshot()).toMatchObject([{ state: { value: 1, kept: 'yes' }, v2Revision: 1 }]);
  expect(linkCollection.snapshot()).toMatchObject([{ targetDocId: 'one', v2Revision: 1 }]);
  expect(dedupeCollection.snapshot()).toEqual([]);
  expect(changeCollection.snapshot()).toHaveLength(1);
  expect(await store.commitProjectionSourceCommit(next)).toMatchObject({ status: 'committed' });
  expect(collection.snapshot()).toMatchObject([{ state: { value: 2, kept: 'yes' }, v2Revision: 2 }]);
  expect(changeCollection.snapshot()).toHaveLength(2);
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail).toMatchObject({
    filter: { _id: 'one', v2Revision: 1 }, update: { $set: { 'state.value': 2, v2Revision: 2 } }
  });
  const session = changeCollection.sessionLog.at(-1)?.session;
  expect(session).toBeDefined();
  for (const written of [collection, linkCollection, dedupeCollection]) expect(written.sessionLog.at(-1)?.session).toBe(session);
});

test('a multi-event patch uses a revision-checked full write, not a flattened delta', async () => {
  const { store, collection, records } = fixtures();
  expect((await store.commitProjectionSourceCommit(projectionChangesRequest())).status).toBe('committed');
  const second = projectionChangesRequest(1);
  const append = second.additionalWrites![0];
  const [target] = append.targets;
  const previousEvent = second.commit.events[0];
  const lastEvent = { ...previousEvent, eventIndex: 1, streamVersion: 2, eventId: 'last' };
  const request: CommitProjectionSourceCommitRequest<{ value: number; kept?: string }> = {
    ...second,
    commit: { ...second.commit, events: [previousEvent, lastEvent] },
    finalDocuments: [{ ...second.finalDocuments[0]!, finalDocument: { value: 3 } }],
    additionalWrites: [{ ...append, targets: [{ ...target!, transitions: [...target!.transitions, {
      changeType: 'update', eventId: lastEvent.eventId, eventIndex: 1,
      patch: [{ op: 'replace', path: '/value', value: 3 }, { op: 'remove', path: '/kept' }]
    }] }] }]
  };
  expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail).toMatchObject({
    filter: { _id: 'one', v2Revision: 1 }, update: { $set: { state: { value: 3 }, v2Revision: 2 } }
  });
  expect(records().at(-1)?.targets[0]?.transitions).toHaveLength(2);
  const stale = { ...request, commit: { ...request.commit, commitSequence: 2 } };
  expect(await store.commitProjectionSourceCommit(stale)).toMatchObject({ status: 'rejected', category: 'conflict' });
  expect(records()).toHaveLength(2);
});

test('reconciles unknown outcome from the durable record, including for none strategy', async () => {
  const { store, records } = fixtures(createFakeMongoClient({ unknownAfterCommitOnTransaction: 2 }));
  const request = projectionChangesRequest();
  const result = await store.commitProjectionSourceCommit(request);
  expect(result).toMatchObject({ status: 'committed', additionalWrites: [records()[0]] });
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'rejected', category: 'conflict' });
  expect(records()).toHaveLength(1);
  expect((await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).targets[0]?.revision).toBe(1);
});

test('unknown empty turn is reconciled with its receipt, not mistaken for a feed record', async () => {
  const { store, records } = fixtures(createFakeMongoClient({ unknownAfterCommitOnTransaction: 2 }));
  const first = projectionChangesRequest();
  const request: typeof first = {
    ...first, finalDocuments: [], stagedLinks: [], additionalWrites: [{ ...first.additionalWrites![0], targets: [] }]
  };
  const result = await store.commitProjectionSourceCommit(request);
  expect(result).toMatchObject({ status: 'committed', emptyChangeReceipt: { kind: 'projection_changes_empty' } });
  const reapplied = await store.commitProjectionSourceCommit(request);
  expect(reapplied).toMatchObject({ status: 'committed', emptyChangeReceipt: { kind: 'projection_changes_empty' } });
  expect(reapplied).not.toEqual(result);
  expect(records()).toEqual([]);
});

test('an unknown outcome without a visible receipt remains transient even if own progress matches', async () => {
  const { store, changeCollection } = fixtures(createFakeMongoClient({ unknownAfterCommitOnTransaction: 2 }));
  const find = changeCollection.findOne.bind(changeCollection);
  changeCollection.findOne = (query, options) => options?.session ? find(query, options) : Promise.resolve(null);
  const first = projectionChangesRequest();
  const request: typeof first = { ...first, progress: {
    strategy: 'own_record', source: { sourceId: first.commit.streamId, expectedSequence: null, finalSequence: 0 }
  } };
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'rejected', category: 'transient', retryable: true });
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'committed' });
});

test('an append error labeled transient remains retryable and leaves no partial writes', async () => {
  const { store, collection, changeCollection, records } = fixtures();
  const first = projectionChangesRequest();
  const request: typeof first = { ...first, progress: {
    strategy: 'own_record', source: { sourceId: first.commit.streamId, expectedSequence: null, finalSequence: 0 }
  } };
  changeCollection.failNextUpdateForId(projectionChangesResumeToken(request), Object.assign(new Error('injected transaction error'), {
    code: 121, hasErrorLabel: (label: string) => label === 'TransientTransactionError'
  }));
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'rejected', category: 'transient', retryable: true });
  expect(collection.snapshot()).toEqual([]);
  expect(records()).toEqual([]);
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'committed' });
});
