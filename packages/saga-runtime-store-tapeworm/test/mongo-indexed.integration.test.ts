import { describe, expect, it } from '@jest/globals';
import { type ICommit } from 'tapeworm';
import { MongoClient, ObjectId, UUID } from 'mongodb';
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
      await expect(repository.append({ ...request, commitId: 'oversized', expectedNextCommitSequence: 1,
        events: [{ type: 'saga.instance_created.event', payload: { text: 'x'.repeat(70_000) } }] }))
        .rejects.toThrow('byte limit');
      await collection.insertOne({ _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
        isDispatched: false, createDateTime: new Date(), id: 'legacy', partitionId: 'sagas', streamId: 'legacy',
        commitSequence: 0, sagaTurnIdentity: identity,
        events: [{ id: 'legacy:event:0', type: 'saga.instance_created.event', version: 0, payload: { text: 'y'.repeat(70_000) } }] });
      await expect(repository.load('legacy')).rejects.toThrow('byte limit');
      await collection.dropIndex('streamId_1_commitSequence_1');
      await expect(repository.load('instance')).rejects.toThrow('Exactly one usable');
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  }, 30_000);
});
