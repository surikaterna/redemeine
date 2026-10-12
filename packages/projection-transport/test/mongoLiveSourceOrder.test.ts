import { expect, jest, test } from '@jest/globals';
import type { Collection } from 'mongodb';
import { liveCommit } from '../../projection-worker-core/test/liveFixtures';
import { MongoLiveSourceOrder, type LiveSourcePositionDocument } from '../src/mongoLiveSourceOrder';
import { liveStart, OrderedLiveFeedFixture } from './orderedLiveFeedFixture';

async function witness() {
  const feed = new OrderedLiveFeedFixture();
  const commit = liveCommit(42);
  feed.append(commit);
  const opened = await feed.openSession(liveStart, { sessionRef: 'channel', queueName: liveStart.queueName, prefetch: 1, exclusive: true });
  if (opened.status !== 'qualified') throw new Error('fixture');
  const delivery = feed.delivery();
  opened.value.reserve(delivery);
  const result = await opened.value.certifyFirst(commit, delivery);
  if (result.status !== 'qualified') throw new Error('fixture');
  return result.value;
}

test('floor majority-CAS ambiguity reconciles exact identity; coverage starts null', async () => {
  const evidence = await witness();
  const row = { _id: JSON.stringify(['epoch', evidence.position.sourceId]), ...evidence.position };
  const findOne = jest.fn<Collection<LiveSourcePositionDocument>['findOne']>().mockResolvedValue(row);
  const updateOne = jest.fn<Collection<LiveSourcePositionDocument>['updateOne']>().mockRejectedValue(new Error('unknown write result'));
  const store = new MongoLiveSourceOrder({ findOne, updateOne });
  expect(await store.admitFirst(evidence)).toEqual(evidence.position);
  expect(updateOne).toHaveBeenCalledWith({ _id: row._id }, { $setOnInsert: evidence.position },
    { upsert: true, writeConcern: { w: 'majority' } });
  expect(findOne).toHaveBeenCalledWith({ _id: row._id }, { readConcern: { level: 'majority' } });
  findOne.mockResolvedValue({ ...row, firstSequence: 43 });
  await expect(store.admitFirst(evidence)).rejects.toThrow('floor_conflict');
  findOne.mockResolvedValue(null);
  await expect(store.admitFirst(evidence)).rejects.toThrow('unknown');
});

test('coverage CAS requires exact floor and exact result, never merely later coverage', async () => {
  const evidence = await witness();
  const row = { _id: JSON.stringify(['epoch', evidence.position.sourceId]), ...evidence.position, coveredThrough: 42 };
  const findOne = jest.fn<Collection<LiveSourcePositionDocument>['findOne']>().mockResolvedValue(row);
  const updateOne = jest.fn<Collection<LiveSourcePositionDocument>['updateOne']>().mockRejectedValue(new Error('unknown'));
  const store = new MongoLiveSourceOrder({ findOne, updateOne });
  expect((await store.advanceCoverage(evidence.position, 42)).coveredThrough).toBe(42);
  expect(updateOne).toHaveBeenCalledWith({ _id: row._id, ...evidence.position }, { $set: { coveredThrough: 42 } },
    { writeConcern: { w: 'majority' } });
  findOne.mockResolvedValue({ ...row, coveredThrough: 43 });
  await expect(store.advanceCoverage(evidence.position, 42)).rejects.toThrow('conflict');
  findOne.mockResolvedValue({ ...row, registryDigest: 'changed' });
  await expect(store.advanceCoverage(evidence.position, 42)).rejects.toThrow('conflict');
  await expect(store.advanceCoverage(evidence.position, 43)).rejects.toThrow('noncontiguous');
});
