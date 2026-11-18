import type { ProjectionDocumentRecord, MongoProjectionChangesRecord } from '../src';
import { MongoProjectionStore, patch6902ToMongoUpdatePlan } from '../src';
import { baselineOrder, legacyOrderWrite, orderCases, orderSnapshotRequest, orderTurn, replayOrderEdits, type Order } from './fineGrainedChangeCases';
import { createFakeMongoClient, createProjectionDedupeCollection, createProjectionLinkCollection, InMemoryMongoCollection } from './mocks';

function storeForOrders() {
  const collection = new InMemoryMongoCollection<ProjectionDocumentRecord<Order>>(true);
  const changeCollection = new InMemoryMongoCollection<MongoProjectionChangesRecord>();
  const store = new MongoProjectionStore({ collection, changeCollection, linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient() });
  return { store, collection, changeCollection };
}

test.each(orderCases)('$name: ordered history and actual Mongo-style write agree', async (scenario) => {
  const { store, collection, changeCollection } = storeForOrders();
  const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
  expect((await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot()))).status).toBe('committed');
  const request = orderTurn(scenario, 1, await snapshot());
  const recorded = request.additionalWrites![0].targets[0]!.transitions;
  expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
  const receipt = changeCollection.snapshot().find((row) => row.commitSequence === 1);
  if (receipt?.kind !== 'projection_changes') throw new Error('Missing persisted history');
  const transitions = receipt.targets[0]!.transitions;
  expect(transitions).toEqual(recorded);
  expect(transitions.map((event) => event.eventIndex)).toEqual(scenario.edits.map((_edit, index) => index));
  const intermediate = replayOrderEdits(transitions);
  expect(intermediate.at(-1)).toEqual(scenario.expected);
  if (scenario.edits.length === 2) {
    expect(intermediate[0]).toEqual(orderCases[0]?.expected);
    expect(transitions[1]?.patch).toEqual([{ op: 'replace', path: '/lines/1/quantity', value: 4 }]);
  }
  expect(await store.load(scenario.name)).toEqual(scenario.expected);
  const [modifier, field] = scenario.write;
  const written = field === 'state' ? scenario.expected : field === 'state.lines' && modifier === '$set'
    ? scenario.expected.lines : expect.anything();
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail).toMatchObject({
    filter: { _id: scenario.name, v2Revision: 1 },
    update: { [modifier]: { [field]: written } }
  });
});

test.each(orderCases.slice(0, 2))('legacy $name uses an array write and rejects a failed source guard', async (scenario) => {
  const { store, collection } = storeForOrders();
  const request = legacyOrderWrite(scenario);
  const { patch, fullDocument } = request.writes[0]!.documents[0]!;
  expect(patch6902ToMongoUpdatePlan(patch, fullDocument)).not.toHaveProperty('orderedArraySet');
  await store.save(scenario.name, baselineOrder, { sequence: 0 });
  expect((await store.commitAtomicMany(request)).status).toBe('committed');
  expect(await store.load(scenario.name)).toEqual(scenario.expected);
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail).toMatchObject({
    filter: { _id: scenario.name, $expr: { $cond: expect.any(Array) } },
    update: { $set: { 'state.lines': scenario.expected.lines } }
  });

  const wrongLength = { ...baselineOrder, lines: baselineOrder.lines.slice(0, 2) };
  await store.save('guarded', wrongLength, { sequence: 0 });
  expect((await store.commitAtomicMany(legacyOrderWrite(scenario, 'guarded'))).status).toBe('rejected');
  expect(await store.load('guarded')).toEqual(wrongLength);
  expect(await store.getCheckpoint('guarded')).toEqual({ sequence: 0 });
});

test('a missing patch ancestor fails before any projection update or outbox append', async () => {
  const { store, collection, changeCollection } = storeForOrders();
  const scenario = orderCases.find(({ name }) => name === 'nested line edit')!;
  const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
  expect((await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot()))).status).toBe('committed');
  const request = orderTurn(scenario, 1, await snapshot());
  const append = request.additionalWrites![0];
  const [target] = append.targets;
  const [transition] = target!.transitions;
  const malformed = { ...request, additionalWrites: [{ ...append, targets: [{ ...target!, transitions: [
    { ...transition!, patch: [{ op: 'replace' as const, path: '/lines/9/quantity', value: 4 }] }
  ] }] }] as const };
  const writes = collection.operationLog.filter(({ op }) => op === 'updateOne').length;
  expect(await store.commitProjectionSourceCommit(malformed)).toMatchObject({ status: 'rejected', category: 'terminal' });
  expect(await store.load(scenario.name)).toEqual(baselineOrder);
  expect(changeCollection.snapshot()).toHaveLength(1);
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne')).toHaveLength(writes);
});
