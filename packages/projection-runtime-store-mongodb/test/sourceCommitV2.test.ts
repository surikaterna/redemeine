import { BSON } from 'mongodb';
import type { CommitProjectionSourceCommitRequest, ProjectionUuidBase64Url22 } from '@redemeine/projection-runtime-core';
import { defineProjectionSourceCommitStoreConformance } from '../../projection-runtime-core/test/sourceCommitStoreConformance';
import { MongoProjectionStore, OWN_PROGRESS_INDEX } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection,
  FakeMongoClient
} from './mocks';

let dedupe = createProjectionDedupeCollection();

defineProjectionSourceCommitStoreConformance(
  'Mongo',
  async () => {
    dedupe = createProjectionDedupeCollection();
    const store = new MongoProjectionStore({
      collection: createProjectionDocumentCollection<{ value: number }>(),
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: dedupe,
      mongoClient: createFakeMongoClient()
    });
    await store.initializeProjectionSourceCommitStore();
    return store;
  },
  () => dedupe.operationLog.length
);

const encodedSource = 'AAAAAAAAQACAAAAAAAAAAQ' as ProjectionUuidBase64Url22;
const makeRequest = (): CommitProjectionSourceCommitRequest<{ value: number; padding?: string }> => ({
  version: 1,
  mode: 'atomic-all',
  projectionName: 'capacity',
  projectionGeneration: 'v1',
  commit: {
    streamId: '00000000-0000-4000-8000-000000000001',
    commitId: '00000000-0000-4000-8000-000000000002',
    commitSequence: 0,
    events: [{ eventId: '00000000-0000-4000-8000-000000000003', eventIndex: 0, streamVersion: 0,
      aggregateType: 'A', aggregateId: 'a', type: 'E', payload: {}, timestamp: '2026-09-22T00:00:00.000Z' }]
  },
  finalDocuments: [
    { targetDocumentId: 'first', expectedRevision: null, finalDocument: { value: 1 } },
    { targetDocumentId: 'second', expectedRevision: null, finalDocument: { value: 2 } }
  ],
  stagedLinks: [{ operation: 'subscribe', targetDocumentId: 'first', aggregateType: 'A', aggregateId: 'a', expectedRevision: null }],
  progress: {
    strategy: 'in_document',
    targets: [
      { targetDocumentId: 'first', expected: {}, final: { [encodedSource]: 0 } },
      { targetDocumentId: 'second', expected: {}, final: { [encodedSource]: 0 } }
    ]
  }
});

test('classifies a driver capacity failure and rolls back every staged write', async () => {
  const documents = createProjectionDocumentCollection<{ value: number }>();
  const linkCollection = createProjectionLinkCollection();
  const dedupeCollection = createProjectionDedupeCollection();
  const store = new MongoProjectionStore({ collection: documents, linkCollection, dedupeCollection, mongoClient: createFakeMongoClient() });
  await store.initializeProjectionSourceCommitStore();
  const capacityError = Object.assign(new Error('BSONObj size is invalid'), { code: 10334, name: 'MongoServerError' });
  documents.failNextUpdateForId('second', capacityError);
  const result = await store.commitProjectionSourceCommit(makeRequest());
  expect(result).toMatchObject({ status: 'rejected', category: 'terminal', retryable: false });
  expect(documents.snapshot()).toEqual([]);
  expect(linkCollection.snapshot()).toEqual([]);
  expect(dedupeCollection.snapshot()).toEqual([]);
});

test('classifies BSON serializer buffer exhaustion as physical capacity', async () => {
  const documents = createProjectionDocumentCollection<{ value: number }>();
  const store = new MongoProjectionStore({
    collection: documents,
    linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(),
    mongoClient: createFakeMongoClient()
  });
  await store.initializeProjectionSourceCommitStore();
  const serializerError = Object.assign(new RangeError('The value of "offset" is out of range'), {
    code: 'ERR_OUT_OF_RANGE',
    stack: 'RangeError: offset\n at serializeInto (/node_modules/bson/src/parser/serializer.ts:1:1)'
  });
  documents.failNextUpdateForId('second', serializerError);
  expect(await store.commitProjectionSourceCommit(makeRequest())).toMatchObject({
    status: 'rejected', category: 'terminal', retryable: false
  });
  expect(documents.snapshot()).toEqual([]);
});

test('creates a unique non-TTL own-record index during readiness', async () => {
  const dedupeCollection = createProjectionDedupeCollection();
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(), linkCollection: createProjectionLinkCollection(),
    dedupeCollection, mongoClient: createFakeMongoClient()
  });
  await store.initializeProjectionSourceCommitStore();
  const index = (await dedupeCollection.listIndexes().toArray()).find((entry) => entry.name === OWN_PROGRESS_INDEX);
  expect(index).toEqual({
    name: OWN_PROGRESS_INDEX,
    key: { projectionName: 1, projectionGeneration: 1, sourceId: 1 },
    unique: true,
    partialFilterExpression: {
      projectionName: { $type: 'string' },
      projectionGeneration: { $type: 'string' },
      sourceId: { $type: 'string' }
    }
  });
});

test('uses actual BSON document bytes for best-effort rate-limited warnings', async () => {
  const warnings: string[] = [];
  const now = '2026-09-22T00:00:00.000Z';
  const base = makeRequest();
  if (base.progress.strategy !== 'in_document') throw new Error('test request strategy');
  const projected = {
    _id: 'first', state: { value: 1 }, updatedAt: now, v2Revision: 1,
    sourceProgress: { [encodedSource]: 0 }
  };
  const request: CommitProjectionSourceCommitRequest<{ value: number; padding?: string }> = {
    ...base,
    finalDocuments: base.finalDocuments.slice(0, 1),
    progress: {
      ...base.progress,
      targets: base.progress.targets.slice(0, 1),
      warnings: { warnAtSourceCount: 0, warnAtMetadataBytes: BSON.calculateObjectSize(projected) - 1 }
    }
  };
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(), linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient(), now: () => now,
    onDedupeWarning: (warning) => {
      warnings.push(`${warning.kind}:${warning.observed}`);
      throw new Error('telemetry unavailable');
    }
  });
  expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
  expect(warnings).toEqual([`source_count:1`, `metadata_bytes:${BSON.calculateObjectSize(projected)}`]);
  const second = {
    ...request,
    commit: { ...request.commit, commitSequence: 5 },
    finalDocuments: [{ targetDocumentId: 'first', expectedRevision: 1, finalDocument: { value: 2 } }],
    stagedLinks: [],
    progress: {
      ...request.progress,
      targets: [{
        targetDocumentId: 'first',
        expected: { [encodedSource]: 0 },
        final: { [encodedSource]: 0, AAAAAAAAAAAAAAAAAAAAAg: 5 }
      }]
    }
  };
  expect((await store.commitProjectionSourceCommit(second)).status).toBe('committed');
  expect(warnings).toHaveLength(2);
});

test('fails readiness closed when transactions are unsupported', async () => {
  const unsupported = Object.assign(new Error('transaction numbers are only allowed on a replica set member'), {
    code: 20,
    name: 'MongoServerError'
  });
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(), linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(),
    mongoClient: createFakeMongoClient({ failWithTransactionError: unsupported })
  });
  await expect(store.initializeProjectionSourceCommitStore()).rejects.toThrow('transactions are required');
});

test('enforces snapshot and majority concerns over caller transaction options', async () => {
  const mongoClient = new FakeMongoClient();
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(),
    linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(),
    mongoClient,
    transactionOptions: { readConcern: 'local', writeConcern: { w: 1 } }
  });
  expect((await store.commitProjectionSourceCommit(makeRequest())).status).toBe('committed');
  expect(mongoClient.sessions).toHaveLength(2);
  for (const session of mongoClient.sessions) {
    expect(session.transactionOptionsLog[0]).toMatchObject({
      readConcern: 'snapshot', writeConcern: { w: 'majority' }
    });
  }
});

test('reconciles a reliable marker after an unknown commit result', async () => {
  const reconciliations: string[] = [];
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(), linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(),
    mongoClient: createFakeMongoClient({ unknownAfterCommitOnTransaction: 2 }),
    onSourceCommitReconciliation: (event) => reconciliations.push(`${event.strategy}:${event.outcome}`)
  });
  const result = await store.commitProjectionSourceCommit(makeRequest());
  expect(result.status).toBe('committed');
  expect(reconciliations).toEqual(['in_document:committed']);
});

test('reports an unknown none outcome as ambiguous and retryable', async () => {
  const base = makeRequest();
  const dedupeCollection = createProjectionDedupeCollection();
  const store = new MongoProjectionStore({
    collection: createProjectionDocumentCollection(), linkCollection: createProjectionLinkCollection(),
    dedupeCollection,
    mongoClient: createFakeMongoClient({ unknownAfterCommitOnTransaction: 2 })
  });
  const result = await store.commitProjectionSourceCommit({ ...base, progress: { strategy: 'none' } });
  expect(result).toMatchObject({ status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome' });
  expect(dedupeCollection.snapshot()).toEqual([]);
  expect(dedupeCollection.operationLog.filter((operation) => operation.op === 'updateOne')).toEqual([]);
});

test.each(['in_document', 'none'] as const)('first-touch %s CASes legacy state/checkpoint before v2 progress or state write', async (strategy) => {
  const documents = createProjectionDocumentCollection<{ value: number }>();
  const store = new MongoProjectionStore({ collection: documents, linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient() });
  const checkpoint = { sequence: 17 };
  await documents.updateOne({ _id: 'first' }, { $set: { state: { value: 4 }, checkpoint, updatedAt: 'old' } }, { upsert: true });
  const loaded = await store.loadProjectionSourceCommitSnapshot({ projectionName: 'capacity', projectionGeneration: 'v1',
    targetDocumentIds: ['first'], links: [], progressStrategy: strategy });
  expect(loaded.targets[0]).toMatchObject({ revision: null, state: { value: 4 }, legacyOriginal: { checkpoint, updatedAt: 'old' } });
  const base = makeRequest();
  const request: CommitProjectionSourceCommitRequest<{ value: number; padding?: string }> = { ...base, stagedLinks: [],
    finalDocuments: [{ targetDocumentId: 'first', expectedRevision: null, finalDocument: { value: 5 },
      legacyOriginal: loaded.targets[0]?.legacyOriginal }],
    progress: strategy === 'none' ? { strategy: 'none' } : { strategy, targets: [{ targetDocumentId: 'first',
      expected: {}, final: { [encodedSource]: 0 } }] } };
  await documents.updateOne({ _id: 'first' }, { $set: { state: { value: 7 }, checkpoint: { sequence: 18 }, updatedAt: 'new' } });
  expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'rejected', category: 'terminal' });
  expect(documents.snapshot()[0]).toMatchObject({ state: { value: 7 }, checkpoint: { sequence: 18 } });
  expect(documents.snapshot()[0]?.v2Revision).toBeUndefined();
  const refreshed = await store.loadProjectionSourceCommitSnapshot({ projectionName: 'capacity', projectionGeneration: 'v1',
    targetDocumentIds: ['first'], links: [], progressStrategy: strategy });
  const adopted = { ...request, finalDocuments: [{ ...request.finalDocuments[0]!, legacyOriginal: refreshed.targets[0]?.legacyOriginal }] };
  expect((await store.commitProjectionSourceCommit(adopted)).status).toBe('committed');
  expect(documents.snapshot()[0]).toMatchObject({ state: { value: 5 }, checkpoint: { sequence: 18 }, v2Revision: 1 });
  if (strategy === 'none') expect(documents.snapshot()[0]?.sourceProgress).toBeUndefined();
  await documents.updateOne({ _id: 'first' }, { $set: { state: { value: 99 }, updatedAt: 'legacy-wrote-again' } });
  await expect(store.loadProjectionSourceCommitSnapshot({ projectionName: 'capacity', projectionGeneration: 'v1',
    targetDocumentIds: ['first'], links: [], progressStrategy: strategy })).rejects.toThrow('Detected legacy writer');
});
