import assert from 'node:assert/strict';
import {
  createProjection, projectionUuidToBase64Url22, replayProjectionChangeTransition, type ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import type { CommandStartedEvent, Db, MongoClient } from 'mongodb';
import { executeProjectionDefinition } from '../../projection-worker-core/src/projectionDefinitionExecutor';
import { createProjectionLaneScheduler } from '../../projection-worker-core/src/targetLaneScheduler';
import { MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDedupeRecord,
  type ProjectionDocumentRecord, type ProjectionLinkRecord } from '../src';

type State = { quantity: number; lastUpdated?: string; nested?: { quantity: number }; items?: Map<string, number> | Set<string> | null };
const sourceId = '00000000-0000-4000-8000-000000000001';
const sourceKey = projectionUuidToBase64Url22(sourceId);
const progressKey = (name: string) => `${name}\0g1\0${sourceId}`;

function source(sequence: number): ProjectionSourceCommit {
  const id = String(sequence + 1).padStart(12, '0');
  return { streamId: sourceId, commitSequence: sequence, commitId: `00000000-0000-4000-8000-${id}`, events: [{
    eventIndex: 0, eventId: `00000000-0000-4000-8001-${id}`, streamVersion: sequence, aggregateType: 'Order',
    aggregateId: 'one', type: 'Change', payload: {}, timestamp: '2026-09-22T00:00:00.000Z'
  }] };
}

function roundtripStore(db: Db, mongoClient: MongoClient) {
  const collection = db.collection<ProjectionDocumentRecord<State>>('rt_docs');
  const changeCollection = db.collection<MongoProjectionChangesRecord>('rt_feed');
  const dedupeCollection = db.collection<ProjectionDedupeRecord>('rt_progress');
  const linkCollection = db.collection<ProjectionLinkRecord>('rt_links');
  return { collection, changeCollection, dedupeCollection, linkCollection,
    store: new MongoProjectionStore({ collection, changeCollection, dedupeCollection, linkCollection, mongoClient }) };
}

function commandTrace(db: Db, mongoClient: MongoClient) {
  let rows: CommandStartedEvent[] | undefined;
  const listener = (event: CommandStartedEvent) => {
    if (event.databaseName === db.databaseName || event.commandName === 'commitTransaction' || event.commandName === 'abortTransaction') {
      rows?.push(event);
    }
  };
  mongoClient.on('commandStarted', listener);
  return {
    begin() { rows = []; },
    end() {
      const commands = rows ?? [];
      rows = undefined;
      return { order: commands.map(({ command, commandName }) => typeof command[commandName] === 'string'
        ? `${commandName}:${command[commandName]}` : commandName),
      transactions: commands.filter(({ command }) => command.startTransaction === true).length,
      writes: commands.reduce((sum, { command }) => sum + (Array.isArray(command.updates) ? command.updates.length : 0), 0),
      singleMajority: commands.some(({ command, commandName }) => commandName === 'update'
        && command.autocommit !== false && command.writeConcern?.w === 'majority') };
    },
    close() { mongoClient.off('commandStarted', listener); }
  };
}

async function checkRoundtrip(
  ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>,
  strategy: 'own_record' | 'in_document', recording: boolean, targets: string[], cold = false, older = false
) {
  const { store, collection, dedupeCollection } = ctx;
  const name = targets[0]!;
  await collection.insertMany(targets.map((_id) => ({ _id, state: { quantity: 0 }, v2Revision: 1, updatedAt: 'seed',
    ...(!older ? { v2WriteId: source(0).commitId } : {}),
    ...(strategy === 'in_document' ? { sourceProgress: { [sourceKey]: 0 } } : {}) })));
  if (strategy === 'own_record') await dedupeCollection.insertOne({ _id: progressKey(name), checkpoint: { sequence: 0 },
    projectionName: name, projectionGeneration: 'g1', sourceId, commitSequence: 0, updatedAt: 'seed' });
  const definition = createProjection<State>(name, () => ({ quantity: 0 }))
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, { Change(draft) { draft.quantity++; } })
    .identity(() => targets).hooks({ afterEach(draft, event) { draft.lastUpdated = event.timestamp; } })
    .deduplication({ strategy }).buildCommitDefinition();
  const run = (commit: ProjectionSourceCommit, alreadyCovered = false) => executeProjectionDefinition({
    definition, generation: 'g1', store, lanes: createProjectionLaneScheduler(), maxConflictRetries: 0, alreadyCovered,
    ...(recording ? { projectionChanges: 'views' } : {})
  }, commit);
  trace.begin();
  assert.equal((await run(source(1))).status, 'committed');
  const observed = trace.end();
  const single = strategy === 'in_document' && targets.length === 1 && !recording && !older;
  const expected = [
    ...(cold ? ['createIndexes:rt_progress', 'listIndexes:rt_progress', 'find:rt_progress', 'commitTransaction'] : []),
    ...targets.map(() => 'find:rt_docs'), ...(strategy === 'own_record' ? ['find:rt_progress'] : []),
    ...(older ? ['find:rt_docs'] : []),
    ...targets.map(() => 'update:rt_docs'), ...(strategy === 'own_record' ? ['update:rt_progress'] : []),
    ...(recording ? ['update:rt_feed'] : []), ...(!single ? ['commitTransaction'] : [])
  ];
  assert.deepEqual(observed, { order: expected, transactions: Number(cold) + Number(!single),
    writes: targets.length + Number(strategy === 'own_record') + Number(recording), singleMajority: single });
  for (const id of targets) assert.deepEqual(await store.load(id), { quantity: 1, lastUpdated: source(1).events[0].timestamp });
  if (recording) {
    trace.begin();
    assert.equal((await run(source(1), true)).status, 'deduplicated');
    assert.deepEqual(trace.end().order, ['find:rt_feed']);
    const mismatched = { ...source(1), commitId: source(2).commitId };
    assert.equal((await run(mismatched, true)).status, 'terminal');
  }
  return { strategy, recording, fanout: targets.length, cold, older, ...observed };
}

async function checkPreparedRace(ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>) {
  const { store, collection } = ctx;
  const id = 'race';
  const get = () => store.loadProjectionSourceCommitSnapshot({ prepareSourceCommit: true, projectionName: id,
    projectionGeneration: 'g1', progressStrategy: 'in_document', targetDocumentIds: [id], links: [] });
  const marker = '00000000-0000-4000-8000-000000000005';
  await collection.insertOne({ _id: id, state: { quantity: 0 }, updatedAt: 'constant',
    v2Revision: 1, v2WriteId: marker, sourceProgress: { [sourceKey]: 0 } });
  const snapshot = await get();
  const request = {
    version: 1 as const, mode: 'atomic-all' as const, projectionName: id, projectionGeneration: 'g1', commit: source(1),
    stagedLinks: [], finalDocuments: [{ targetDocumentId: id, expectedRevision: 1, finalDocument: { quantity: 4 } }],
    progress: { strategy: 'in_document' as const, targets: [{ targetDocumentId: id, expected: { [sourceKey]: 0 }, final: { [sourceKey]: 1 } }] }
  };
  const fresh = await get();
  trace.begin();
  assert.equal((await store.commitProjectionSourceCommit(request, fresh)).status, 'committed');
  const commitOnly = trace.end();
  assert.deepEqual(commitOnly.order, ['update:rt_docs']);
  assert.equal(commitOnly.transactions, 0);
  assert.equal((await store.commitProjectionSourceCommit(request, snapshot)).status, 'rejected');
  await collection.replaceOne({ _id: id }, { state: { quantity: 7 }, updatedAt: 'constant', v2Revision: 1,
    v2WriteId: '00000000-0000-4000-8000-000000000006', sourceProgress: { [sourceKey]: 0 } });
  assert.equal((await store.commitProjectionSourceCommit(request, snapshot)).status, 'rejected');
  assert.deepEqual(await store.load(id), { quantity: 7 });
  return commitOnly;
}

async function checkEmptyReceipt(ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>) {
  const { store } = ctx;
  const scope = { projectionName: 'empty', projectionGeneration: 'g1' };
  const emptyTurn = (commit: ProjectionSourceCommit) => ({
    ...scope, version: 1 as const, mode: 'atomic-all' as const, commit, stagedLinks: [], finalDocuments: [],
    progress: { strategy: 'in_document' as const, targets: [] },
    additionalWrites: [{ kind: 'projection_changes' as const, collection: 'views', targets: [] }] as const
  });
  const get = (commit: ProjectionSourceCommit) => store.loadProjectionSourceCommitSnapshot({
    ...scope, prepareSourceCommit: true, progressStrategy: 'in_document', targetDocumentIds: [], links: [],
    changeIdentity: { sourceId, commitId: commit.commitId, commitSequence: commit.commitSequence, collection: 'views' }
  });
  const commit = source(1);
  const snapshot = await get(commit);
  const request = emptyTurn(commit);
  assert.equal((await store.commitProjectionSourceCommit(request, snapshot)).status, 'committed');
  trace.begin();
  const replay = await store.commitProjectionSourceCommit(request, snapshot);
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replayed, true);
  const duplicate = trace.end();
  assert.deepEqual(duplicate.order, ['update:rt_feed', 'abortTransaction', 'find:rt_feed']);
  const mismatch = { ...commit, commitId: source(2).commitId };
  assert.deepEqual(await store.commitProjectionSourceCommit(emptyTurn(mismatch), await get(mismatch)), {
    version: 1, status: 'rejected', category: 'terminal', retryable: false,
    reason: 'projection change source commit or collection identity mismatch'
  });
  return duplicate;
}

async function checkOwnProgressRace(ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>) {
  const { store, dedupeCollection } = ctx;
  const id = 'own-off';
  const scope = { projectionName: id, projectionGeneration: 'g1' };
  const snapshot = await store.loadProjectionSourceCommitSnapshot({ ...scope, prepareSourceCommit: true,
    targetDocumentIds: [id], links: [], progressStrategy: 'own_record', sourceId });
  await dedupeCollection.updateOne({ _id: progressKey(id) }, { $set: { commitSequence: 2 } });
  trace.begin();
  const raced = await store.commitProjectionSourceCommit({ ...scope, version: 1, mode: 'atomic-all', commit: source(2),
    finalDocuments: [{ targetDocumentId: id, expectedRevision: 2, finalDocument: { quantity: 99 } }], stagedLinks: [],
    progress: { strategy: 'own_record', source: { sourceId, expectedSequence: 1, finalSequence: 2 } }
  }, snapshot);
  const race = trace.end();
  assert.deepEqual(race.order, ['update:rt_docs', 'update:rt_progress', 'abortTransaction']);
  assert.equal(raced.status, 'rejected');
  assert.equal(raced.category, 'conflict');
  assert.deepEqual(await store.load(id), { quantity: 1, lastUpdated: source(1).events[0].timestamp });
  return race;
}

async function checkSignedZero(
  ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>, recording: boolean, intermediate = false
) {
  const { store, collection, changeCollection } = ctx;
  const id = intermediate ? 'signed-zero-final-negative' : recording ? 'signed-zero-on' : 'signed-zero-off';
  const initial = { quantity: +0 };
  await collection.insertOne({ _id: id, state: initial, updatedAt: 'seed', v2Revision: 1,
    v2WriteId: source(0).commitId, sourceProgress: { [sourceKey]: 0 } });
  const definition = createProjection<State>(id, () => initial)
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
      Change(draft) { if (intermediate) draft.quantity = 1; }
    })
    .identity(() => id).hooks({ afterEach(draft) { draft.quantity = -0; } })
    .deduplication({ strategy: 'in_document' }).buildCommitDefinition();
  trace.begin();
  const result = await executeProjectionDefinition({ definition, generation: 'g1', store,
    lanes: createProjectionLaneScheduler(), maxConflictRetries: 0, ...(recording ? { projectionChanges: 'views' } : {})
  }, source(1));
  assert.equal(result.status, 'committed');
  assert.deepEqual(trace.end().order, ['find:rt_docs', 'update:rt_docs', ...(recording ? ['update:rt_feed', 'commitTransaction'] : [])]);
  const row = await collection.findOne({ _id: id });
  assert.ok(row);
  assert.deepEqual(row.state, { quantity: intermediate ? -0 : +0 }); // Strict equality distinguishes the zero signs.
  assert.equal(row.v2Revision, 2);
  assert.equal(row.sourceProgress?.[sourceKey], 1);
  const receipt = await changeCollection.findOne({ projectionName: id });
  if (recording) {
    assert.equal(receipt?.kind, 'projection_changes');
    const [transition] = receipt.targets[0]!.transitions;
    assert.equal(transition?.changeType, 'noop');
    assert.deepEqual(transition.patch, []);
    assert.deepEqual(replayProjectionChangeTransition(initial, transition), row.state);
  } else assert.equal(receipt, null);
  return 'passed';
}

async function checkRecordedStateBoundary(
  ctx: ReturnType<typeof roundtripStore>, trace: ReturnType<typeof commandTrace>
) {
  const { store, collection, changeCollection } = ctx;
  for (const kind of ['scalar-zero', 'replacement-zero', 'Map', 'Set', 'strict-opt-out']) {
    const id = `recorded-boundary-${kind}`;
    const initial = { quantity: 0, nested: { quantity: 0 }, items: null };
    const seed = { _id: id, state: initial, updatedAt: 'seed', v2Revision: 1,
      v2WriteId: source(0).commitId, sourceProgress: { [sourceKey]: 0 } };
    await collection.insertOne(seed);
    const definition = createProjection<State>(id, () => initial)
      .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
        Change(draft) {
          if (kind === 'scalar-zero' || kind === 'strict-opt-out') draft.quantity = 1;
          if (kind === 'replacement-zero') draft.nested = { quantity: 0 };
          if (kind === 'Map') draft.items = new Map();
          if (kind === 'Set') draft.items = new Set();
        }
      }).identity(() => id).hooks({ afterEach(draft) {
        if (kind === 'scalar-zero' || kind === 'strict-opt-out') draft.quantity = -0;
        if (kind === 'replacement-zero') draft.nested!.quantity = -0;
        if (draft.items instanceof Map) draft.items.set('orders', 4);
        if (draft.items instanceof Set) draft.items.add('orders');
      } }).deduplication({ strategy: 'in_document' }).buildCommitDefinition();
    trace.begin();
    const result = await executeProjectionDefinition({ definition, generation: 'g1', store, stateValidation: { changes: true },
      ...(kind === 'strict-opt-out' ? {} : { projectionChanges: 'views' }),
      lanes: createProjectionLaneScheduler(), maxConflictRetries: 0 }, source(1));
    assert.equal(result.status, 'terminal', kind);
    assert.match(result.reason, /portable JSON/, kind);
    assert.equal(trace.end().writes, 0, kind);
    assert.deepEqual(await collection.findOne({ _id: id }), seed, kind);
    assert.equal(await changeCollection.findOne({ projectionName: id }), null, kind);
  }
  return 'passed';
}

export async function checkRealSourceCommitRoundTrips(db: Db, mongoClient: MongoClient) {
  const ctx = roundtripStore(db, mongoClient);
  await db.createCollection(ctx.changeCollection.collectionName);
  const trace = commandTrace(db, mongoClient);
  try {
    const inline = await checkRoundtrip(ctx, trace, 'in_document', false, ['inline'], true);
    const warmInline = await checkRoundtrip(ctx, trace, 'in_document', false, ['warm-inline']);
    const olderInline = await checkRoundtrip(ctx, trace, 'in_document', false, ['older-inline'], false, true);
    const ownOff = await checkRoundtrip(ctx, trace, 'own_record', false, ['own-off']);
    const ownOn = await checkRoundtrip(ctx, trace, 'own_record', true, ['own-on']);
    const fanout = await checkRoundtrip(ctx, trace, 'own_record', true, ['fanout-a', 'fanout-b']);
    const storeOnly = await checkPreparedRace(ctx, trace);
    const duplicateEmpty = await checkEmptyReceipt(ctx, trace);
    const ownProgressRace = await checkOwnProgressRace(ctx, trace);
    const signedZero = {
      on: await checkSignedZero(ctx, trace, true),
      off: await checkSignedZero(ctx, trace, false),
      finalizedNegativeOff: await checkSignedZero(ctx, trace, false, true)
    };
    const recordedStateBoundary = await checkRecordedStateBoundary(ctx, trace);
    return { inline, warmInline, olderInline, ownOff, ownOn, fanout, storeOnly, duplicateEmpty, ownProgressRace, signedZero, recordedStateBoundary };
  } finally {
    trace.close();
  }
}
