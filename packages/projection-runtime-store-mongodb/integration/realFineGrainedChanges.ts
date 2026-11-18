import assert from 'node:assert/strict';
import type { CommandStartedEvent, Db, MongoClient } from 'mongodb';
import {
  MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDocumentRecord,
  type ProjectionDedupeRecord, type ProjectionLinkRecord
} from '../src';
import { baselineOrder, legacyOrderWrite, orderCases, orderSnapshotRequest, orderTurn, replayOrderEdits, type Order } from '../test/fineGrainedChangeCases';

type Write = { q: Record<string, unknown>; u: Record<string, Record<string, unknown>> };

async function checkLegacyArraySet(store: MongoProjectionStore<Order>, writes: readonly Write[]): Promise<void> {
  const scenario = orderCases[0]!;
  await store.save('legacy', baselineOrder, { sequence: 0 });
  const result = await store.commitAtomicMany(legacyOrderWrite(scenario, 'legacy'));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.deepEqual(writes.at(-1)?.u.$set?.['state.lines'], scenario.expected.lines);
  assert.deepEqual(await store.load('legacy'), scenario.expected);

  const wrongLength = { ...baselineOrder, lines: baselineOrder.lines.slice(0, 2) };
  await store.save('legacy-guarded', wrongLength, { sequence: 0 });
  const request = legacyOrderWrite(scenario, 'legacy-guarded');
  const write = request.writes[0]!;
  const rejected = await store.commitAtomicMany({ ...request, writes: [{ ...write, documents: [
    { mode: 'full', documentId: 'legacy-rollback', fullDocument: baselineOrder, checkpoint: { sequence: 1 } },
    ...write.documents
  ] }] });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.failure.category, 'conflict');
  assert.deepEqual(await store.load('legacy-guarded'), wrongLength);
  assert.deepEqual(await store.getCheckpoint('legacy-guarded'), { sequence: 0 });
  assert.equal(await store.load('legacy-rollback'), null);
}

export async function checkRealFineGrainedChanges(db: Db, mongoClient: MongoClient): Promise<void> {
  const collection = db.collection<ProjectionDocumentRecord<Order>>('fine_grained_orders');
  const changeCollection = await db.createCollection<MongoProjectionChangesRecord>('fine_grained_feed');
  const store = new MongoProjectionStore({ collection, changeCollection, mongoClient,
    linkCollection: db.collection<ProjectionLinkRecord>('fine_grained_links'),
    dedupeCollection: db.collection<ProjectionDedupeRecord>('fine_grained_dedupe') });
  const writes: Write[] = [];
  const monitor = ({ commandName, command }: CommandStartedEvent): void => {
    if (commandName === 'update' && command.update === collection.collectionName) writes.push(...command.updates as Write[]);
  };
  mongoClient.on('commandStarted', monitor);
  try {
    for (const scenario of orderCases) {
      const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
      assert.equal((await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot()))).status, 'committed', scenario.name);
      const request = orderTurn(scenario, 1, await snapshot());
      assert.equal((await store.commitProjectionSourceCommit(request)).status, 'committed', scenario.name);
      const receipt = await changeCollection.findOne({ projectionName: scenario.name, commitSequence: 1 });
      assert.equal(receipt?.kind, 'projection_changes');
      if (receipt?.kind !== 'projection_changes') throw new Error('Missing order receipt');
      const transitions = receipt.targets[0]!.transitions;
      assert.deepEqual(transitions, request.additionalWrites![0].targets[0]!.transitions);
      assert.deepEqual(replayOrderEdits(transitions).at(-1), scenario.expected, scenario.name);
      assert.deepEqual(await store.load(scenario.name), scenario.expected, scenario.name);

      const [modifier, field] = scenario.write;
      const write = writes.at(-1);
      assert.deepEqual(write?.q, { _id: scenario.name, v2Revision: 1 });
      assert.ok(write?.u[modifier] && Object.hasOwn(write.u[modifier]!, field), `${scenario.name}: ${JSON.stringify(write?.u)}`);
      if (field === 'state') assert.deepEqual(write.u.$set?.state, scenario.expected);
      else assert.equal(Object.hasOwn(write.u.$set ?? {}, 'state'), false);
      if (field === 'state.lines' && modifier === '$set') assert.deepEqual(write.u.$set?.[field], scenario.expected.lines);
      if (scenario.name === 'nested line edit') assert.equal(write.u.$set?.[field], 4);
    }
    await checkLegacyArraySet(store, writes);
  } finally {
    mongoClient.off('commandStarted', monitor);
  }
}
