import type { ProjectionDocumentRecord, MongoProjectionChangesRecord, MongoSourceCommitPatchPlanEvent } from '../src';
import { MongoProjectionStore, patch6902ToMongoUpdatePlan } from '../src';
import { BSON } from 'mongodb';
import { planSourceDocumentWrite } from '../src/store/sourceCommitDelta';
import { baselineOrder, legacyOrderWrite, orderCases, orderSnapshotRequest, orderTurn, replayOrderEdits, stateWriteShape, type Order } from './fineGrainedChangeCases';
import { createFakeMongoClient, createProjectionDedupeCollection, createProjectionLinkCollection, InMemoryMongoCollection } from './mocks';

function storeForOrders(recording = true) {
  const collection = new InMemoryMongoCollection<ProjectionDocumentRecord<Order>>(true);
  const changeCollection = new InMemoryMongoCollection<MongoProjectionChangesRecord>();
  const decisions: MongoSourceCommitPatchPlanEvent[] = [];
  const store = new MongoProjectionStore({ collection, ...(recording ? { changeCollection } : {}),
    onSourceCommitPatchPlan: (event) => decisions.push(event), linkCollection: createProjectionLinkCollection(),
    dedupeCollection: createProjectionDedupeCollection(), mongoClient: createFakeMongoClient() });
  return { store, collection, changeCollection, decisions };
}

test.each(orderCases.flatMap((scenario) => [true, false].map((recording) => ({ scenario, recording }))))(
  '$scenario.name: actual Mongo-style write, recording=$recording', async ({ scenario, recording }) => {
  const { store, collection, changeCollection, decisions } = storeForOrders(recording);
  const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
  expect((await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot(), recording))).status).toBe('committed');
  const request = orderTurn(scenario, 1, await snapshot(), recording);
  const hint = request.finalDocuments[0]!.statePatch;
  if (hint?.kind !== 'ordered') throw new Error('Missing ordered state patch');
  const transitions = hint.transitions;
  const outcome = await store.commitProjectionSourceCommit(request);
  expect(outcome).toMatchObject({ status: 'committed', documentRevisions: { [scenario.name]: 2 } });
  const receipt = changeCollection.snapshot().find((row) => row.commitSequence === 1);
  if (recording) {
    expect(request.additionalWrites![0].targets[0]!.transitions).toBe(transitions);
    expect(receipt).toMatchObject({ kind: 'projection_changes', targets: [{ transitions }] });
  } else {
    expect(request.additionalWrites).toBeUndefined();
    expect(outcome).not.toHaveProperty('additionalWrites');
    expect(receipt).toBeUndefined();
  }
  expect(transitions.map((event) => event.eventIndex)).toEqual(scenario.edits.map((_edit, index) => index));
  const intermediate = replayOrderEdits(transitions);
  expect(intermediate.at(-1)).toEqual(scenario.expected);
  if (scenario.edits[0] === 'RemoveMiddle' && scenario.edits.length === 2) {
    expect(intermediate[0]).toEqual(orderCases[0]?.expected);
    expect(transitions[1]?.patch).toEqual([{ op: 'replace', path: '/lines/1/quantity', value: 4 }]);
  }
  expect(await store.load(scenario.name)).toEqual(scenario.expected);
  expect((await snapshot()).ownRecordSequence).toBe(1);
  const write = collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail as {
    filter: unknown; update: Record<string, Record<string, unknown>>;
  };
  expect(write.filter).toEqual({ _id: scenario.name, v2Revision: 1 });
  expect(stateWriteShape(write.update)).toEqual(scenario.writes);
  const historyRecording = recording ? 'enabled' : 'disabled';
  expect(decisions.at(-1)).toEqual(scenario.writes.includes('$set:state')
    ? { mode: 'full', reason: 'unsafe-delta', historyRecording }
    : { mode: scenario.writes.length ? 'delta' : 'metadata-only', historyRecording });
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

test('an unproven runtime hint falls back to the final document without requiring history', async () => {
  const { store, collection, decisions } = storeForOrders(false);
  const scenario = orderCases.find(({ name }) => name === 'nested line edit')!;
  const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
  await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot(), false));
  const request = orderTurn(scenario, 1, await snapshot(), false);
  const document = request.finalDocuments[0]!;
  const patch = document.statePatch;
  if (patch?.kind !== 'ordered') throw new Error('Missing runtime patch');
  const statePatch = { ...patch, transitions: [{ ...patch.transitions[0]!,
    patch: [{ op: 'replace' as const, path: '/lines/9/quantity', value: 4 }] }] };
  expect(await store.commitProjectionSourceCommit({ ...request, finalDocuments: [{ ...document, statePatch }] }))
    .toMatchObject({ status: 'committed' });
  expect(await store.load(scenario.name)).toEqual(scenario.expected);
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').at(-1)?.detail)
    .toMatchObject({ update: { $set: { state: scenario.expected } } });
  expect(decisions.at(-1)).toEqual({ mode: 'full', reason: 'invalid-state-patch', historyRecording: 'disabled' });
});

test('a later write failure rolls back a disabled turn after its delta was applied', async () => {
  const { store, collection } = storeForOrders(false);
  const scenario = orderCases.find(({ name }) => name === 'independent events')!;
  const snapshot = () => store.loadProjectionSourceCommitSnapshot(orderSnapshotRequest(scenario));
  await store.commitProjectionSourceCommit(orderTurn(scenario, 0, await snapshot(), false));
  const request = orderTurn(scenario, 1, await snapshot(), false);
  const failure = Object.assign(new Error('BSON object too large'), { code: 10334 });
  collection.failNextUpdateForId('fails', failure);
  expect(await store.commitProjectionSourceCommit({
    ...request, finalDocuments: [...request.finalDocuments,
      { targetDocumentId: 'fails', expectedRevision: null, finalDocument: baselineOrder }]
  })).toMatchObject({ status: 'rejected', category: 'terminal' });
  expect(collection.operationLog.filter(({ op }) => op === 'updateOne').some(({ detail }) =>
    Object.hasOwn((detail as { update: { $set?: object } }).update.$set ?? {}, 'state.lines.1.quantity'))).toBe(true);
  expect(await snapshot()).toMatchObject({ targets: [{ state: baselineOrder, revision: 1 }], ownRecordSequence: 0 });
});

test('repeated dotted prefixes cannot push a modifier past the BSON limit', () => {
  const key = 'nested'.repeat(50);
  const origin = { [key]: { a: '', b: '' } };
  const value = 'x'.repeat(8 * 1024 * 1024 - 200);
  const finalDocument = { [key]: { a: value, b: value } };
  const transitions = [{ changeType: 'update' as const, eventId: 'event', eventIndex: 0,
    patch: ['a', 'b'].map((field) => ({ op: 'replace' as const, path: `/${key}/${field}`, value })) }];
  const { decision, update } = planSourceDocumentWrite(
    { targetDocumentId: 'one', expectedRevision: 1, finalDocument }, { transitions, unchanged: false }, origin, { v2Revision: 2 }
  );
  expect(decision).toEqual({ mode: 'full', reason: 'modifier-capacity' });
  expect(stateWriteShape(update as Record<string, Record<string, unknown>>)).toEqual(['$set:state']);
  expect(BSON.calculateObjectSize(update)).toBeLessThan(16 * 1024 * 1024);
});
