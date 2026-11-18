import type { CommitProjectionSourceCommitRequest } from '@redemeine/projection-runtime-core';
import { changeSnapshotRequest, projectionChangesRequest } from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { projectionUuidToBase64Url22 } from '@redemeine/projection-runtime-core';
import { MongoProjectionStore } from '../src';
import { createFakeMongoClient, createProjectionDedupeCollection, createProjectionDocumentCollection, createProjectionLinkCollection } from './mocks';

async function inlineFixture() {
  const collection = createProjectionDocumentCollection<{ value: number }>();
  const store = new MongoProjectionStore({ collection, linkCollection: createProjectionLinkCollection(),
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
  const get = () => store.loadProjectionSourceCommitSnapshot({ ...changeSnapshotRequest,
    links: [], progressStrategy: 'in_document', prepareSourceCommit: true });
  return { store, collection, get, request: inline(1), key };
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
