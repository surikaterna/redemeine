import { describe, expect, it } from '@jest/globals';
import { type ICommit } from 'tapeworm';
import { BSON, MongoClient, ObjectId, UUID } from 'mongodb';
import { IndexedSagaCommitReader } from '../src/IndexedSagaCommitReader';
import { openMongoSagaTurnRepository } from '../src/TapewormSagaTurnRepository';
import type { TapewormSagaEvent } from '../src/contracts';

const uri = process.env.REDEMEINE_MONGO_URL;

(uri ? describe : describe.skip)('real Tapeworm Mongo saga indexed pages', () => {
  it('reads the actual writable partition, rejects oversized material and rechecks indexes', async () => {
    const client = new MongoClient(uri!);
    const database = client.db(`saga_7hd4_${Date.now()}_${process.pid}`);
    try {
      await client.connect();
      const repository = await openMongoSagaTurnRepository(database, 'sagas');
      const collection = database.collection<ICommit<TapewormSagaEvent>>('tw_sagas_commits');
      const reader = new IndexedSagaCommitReader(collection, 'sagas');
      const indexes = await collection.listIndexes().toArray();
      const ordered = indexes.filter(({ key, unique, sparse, partialFilterExpression, hidden, expireAfterSeconds }) =>
        unique === true && Object.keys(key).join(',') === 'streamId,commitSequence'
        && key.streamId === 1 && key.commitSequence === 1 && !sparse && !partialFilterExpression && !hidden && expireAfterSeconds === undefined);
      expect(ordered).toHaveLength(1);
      const plan = await collection.find({ streamId: 'instance', commitSequence: { $gt: -1, $lte: 1 } })
        .sort({ commitSequence: 1 }).hint(ordered[0]!.name).limit(2).explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
      const identity = { sourceTriggerId: 'source-0', sagaKey: 'orders', instanceId: 'instance', routeId: 'route' };
      const request = { streamId: 'instance', commitId: 'commit-0', expectedNextCommitSequence: 0, identity,
        events: [{ type: 'saga.instance_created.event', payload: { id: 'instance' } }] };
      expect((await repository.append(request)).status).toBe('committed');
      const persisted = await collection.findOne({ id: request.commitId });
      expect(persisted).toMatchObject({ partitionId: 'sagas', streamId: 'instance', commitSequence: 0 });
      expect(persisted?._id).toBeInstanceOf(ObjectId);
      expect(persisted?.token).toBeInstanceOf(UUID);
      const snapshot = await repository.load('instance');
      const commits = [];
      for await (const commit of snapshot.commits) commits.push(commit);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.events[0]?.version).toBe(0);
      expect(await reader.capture('instance')).toBe(0);
      expect((await reader.page('instance', -1, 0)).commits.map(({ commitSequence }) => commitSequence)).toEqual([0]);
      expect((await reader.page('instance', 0, 0)).commits).toEqual([]);
      expect(await reader.capture('empty')).toBe(-1);
      const largeState = { blob: 'x'.repeat(1_500_000) };
      const large = { streamId: 'large', commitId: 'large-0', expectedNextCommitSequence: 0,
        identity: { ...identity, instanceId: 'large' },
        events: [{ type: 'saga.business_state_recorded.event', payload: { state: largeState } }] };
      expect((await repository.append(large)).status).toBe('committed');
      const persistedLarge = await collection.findOne({ id: 'large-0' });
      expect(BSON.calculateObjectSize(persistedLarge!)).toBeGreaterThan(1_500_000);
      expect(BSON.calculateObjectSize(persistedLarge!)).toBeLessThan(12 * 1024 * 1024);
      expect((await reader.page('large', -1, 0)).commits).toHaveLength(1);
      expect((await repository.append(large)).status).toBe('reconciled');
      await expect(repository.append({ ...request, commitId: 'oversized', expectedNextCommitSequence: 1,
         events: [{ type: 'saga.instance_created.event', payload: { text: 'x'.repeat(10 * 1024 * 1024) } }] }))
        .rejects.toThrow('byte limit');
      await collection.insertOne({ _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
        isDispatched: false, createDateTime: new Date(), id: 'legacy', partitionId: 'sagas', streamId: 'legacy',
        commitSequence: 0, sagaTurnIdentity: identity,
         events: [{ id: 'legacy:event:0', type: 'saga.instance_created.event', version: 0, payload: { text: 'y'.repeat(12 * 1024 * 1024) } }] });
      await expect(repository.load('legacy')).rejects.toThrow('byte limit');
      await collection.insertOne({ _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
        isDispatched: false, createDateTime: new Date(), id: 'gap', partitionId: 'sagas', streamId: 'gap',
        commitSequence: 1, sagaTurnIdentity: identity,
        events: [{ id: 'gap:event:0', type: 'saga.instance_created.event', version: 1, payload: {} }] });
      await expect(reader.page('gap', -1, 1)).rejects.toThrow('gap');
      const capture = await reader.capture('instance');
      await collection.insertOne({ _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
        isDispatched: false, createDateTime: new Date(), id: 'later', partitionId: 'sagas', streamId: 'instance',
        commitSequence: 1, sagaTurnIdentity: identity,
        events: [{ id: 'later:event:0', type: 'saga.instance_created.event', version: 1, payload: {} }] });
      expect((await reader.page('instance', -1, capture)).commits).toHaveLength(1);
      await collection.dropIndex('streamId_1_commitSequence_1');
      await expect(repository.load('instance')).rejects.toThrow('Exactly one usable');
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  }, 30_000);
});
