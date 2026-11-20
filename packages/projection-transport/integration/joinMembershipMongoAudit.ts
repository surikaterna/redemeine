import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjection, type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import type { Collection, CommandStartedEvent } from 'mongodb';
import type { ProjectionDocumentRecord } from '@redemeine/projection-runtime-store-mongodb';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, routed, snapshot, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

function interleavingDefinition() {
  const board = { aggregateType: 'Board', pure: { eventProjectors: { setup() {}, writer() {} } } };
  const order = { aggregateType: 'Order', pure: { eventProjectors: { visit() {} } } };
  return createProjection('boards', (id): State => ({ id, visits: [] }))
    .from(board, {
      setup(draft, _event, ctx) { ctx.subscribeTo(order, orderId); draft.visits.push('seed'); },
      writer(draft, _event, ctx) {
        if (draft.id === 'C') ctx.unsubscribeFrom(order, orderId);
        else draft.visits.push('concurrent-create');
      }
    })
    .identity((event) => event.type === 'writer' ? ['A', 'C'] : event.aggregateId)
    .join(order, { visit(draft) {
      if (draft.id !== 'A' || draft.visits.includes('concurrent-create')) draft.visits.push('applied');
    } }).joinRight(order, { visit: () => ['A', 'B'] })
    .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
}

function interceptViewRead(docs: Collection<ProjectionDocumentRecord<State>>, afterRead: () => Promise<void>) {
  let reads = 0;
  const collection = new Proxy(docs, { get(target, key) {
    if (key !== 'find') {
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return (...args: Parameters<typeof target.find>) => {
      const cursor = target.find(...args);
      const filter = args[0] as { _id?: { $in?: string[] } };
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const observed = await toArray();
        if (filter._id?.$in?.includes('A') && ++reads === 1) {
          assert.deepEqual(observed.map((row) => row._id).sort(), ['C']);
          await afterRead();
        }
        return observed;
      };
      return cursor;
    };
  } });
  return { collection, reads: () => reads };
}

export async function runFracturedReadRegression(docs: Collection<ProjectionDocumentRecord<State>>,
  makeStore: (docs?: Collection<ProjectionDocumentRecord<State>>) => ProjectionSourceCommitStorePort<State>,
  fallback: boolean, concurrent: boolean): Promise<void> {
  const definition = interleavingDefinition();
  const setup = (store: ProjectionSourceCommitStorePort<State>) => {
    const options = fixtureOptions(store);
    return { ...options, definitions: [{ ...options.definitions[0]!, definition }] };
  };
  const writer = coordinator(setup(makeStore()));
  const boardTurn = (id: string, type: string) => turn(randomUUID(), 0, id, [[type]], 'Board');
  await completed(writer, boardTurn('C', 'setup'));
  const observed = interceptViewRead(docs, async () => {
    if (!concurrent) return;
    await completed(writer, boardTurn('unused', 'writer'));
    assert.deepEqual((await docs.findOne({ _id: 'A' }))?.state.visits, ['concurrent-create']);
  });
  const store = makeStore(observed.collection);
  let conflicts = 0;
  let writes = 0;
  const options = setup({
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    ...(fallback ? {} : { sourceCommitSnapshotCapability: store.sourceCommitSnapshotCapability }),
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    async commitProjectionSourceCommit(request, proof) {
      if (++writes === 1) assert.deepEqual(request.finalDocuments.map((doc) => doc.targetDocumentId), ['B', 'C']);
      const result = await store.commitProjectionSourceCommit(request, proof);
      if (result.status === 'rejected' && result.category === 'conflict') conflicts++;
      return result;
    }
  });
  const source = randomUUID();
  const main = turn(source, 0, orderId, [['visit']]);
  await completed(coordinator(options), main);
  const current = await snapshot(makeStore(), source, ['A', 'B', 'C']);
  assert.equal(conflicts, concurrent ? 1 : 0);
  assert(observed.reads() >= (concurrent ? 2 : 1));
  assert.equal(current.ownRecordSequence, 0);
  assert.equal(await fixtureCoverage(options, main), 0);
  assert.deepEqual(current.joinMemberships?.[0]?.targetDocumentIds, concurrent ? [] : ['C']);
  assert.deepEqual(current.targets.map(({ state }) => state?.visits ?? null),
    concurrent ? [['concurrent-create', 'applied'], ['applied'], ['seed']] : [null, ['applied'], ['seed', 'applied']]);
  console.log(JSON.stringify({ scenario: 'create-A-unlink-C', fallback, concurrent, conflicts, viewReads: observed.reads() }));
}

function readCounts(commands: CommandStartedEvent[], name: string) {
  const relevant = commands.filter((entry) => entry.databaseName === name);
  const ops = (type: string, collection: string) => relevant.filter(({ command }) => command[type] === collection).length;
  return { views: ops('find', 'views'), memberships: ops('find', 'memberships'), progress: ops('find', 'progress'),
    viewWrites: ops('update', 'views') };
}

export async function runMultiEventBatch(store: ProjectionSourceCommitStorePort<State>, name: string, commands: CommandStartedEvent[],
  fallback: boolean) {
  const runtime = coordinator(fixtureOptions(fallback ? {
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    commitProjectionSourceCommit: store.commitProjectionSourceCommit.bind(store)
  } : store));
  for (const count of [1, 8, 32]) {
    const source = randomUUID();
    const ids = Array.from({ length: count }, (_, i) => `candidate-${source}-${i}`);
    const commit = turn(source, 0, orderId, ids.map((id) => [routed, { targets: id }]));
    commands.length = 0;
    const result = await completed(runtime, commit);
    const { views, memberships, progress, viewWrites } = readCounts(commands, name);
    const transactionCommits = commands.filter(({ commandName }) => commandName === 'commitTransaction').length;
    assert.deepEqual([views, memberships, progress, viewWrites], fallback ? [2, 3, 3, 1] : [1, 2, 2, 1]);
    assert.equal(transactionCommits, 3);
    const state = await snapshot(store, source, ids);
    assert.deepEqual(state.targets.map((row) => row.state?.visits), ids.map(() => ['routed']));
    console.log(JSON.stringify({ scenario: 'multi-event', count, fallback, views, memberships, progress, transactionCommits,
      attempts: result.definitions[0]?.outcome.attempts }));
  }
  const source = randomUUID();
  const extra = Array.from({ length: 32 }, (_, i) => ({ aggregateType: 'Order', aggregateId: `extra-${i}` }));
  const dynamic = turn(source, 0, orderId, extra.map((row, index) =>
    [routed, { targets: `dynamic-candidate-${index}`, extra: row.aggregateId }]));
  commands.length = 0;
  const result = await completed(runtime, dynamic);
  assert.equal(result.definitions[0]?.outcome.attempts, 2);
  const counts = readCounts(commands, name);
  assert.deepEqual(Object.values(counts), fallback ? [3, 4, 4, 1] : [2, 3, 3, 1]);
  const stored = await snapshot(store, source, [], extra);
  assert.deepEqual(stored.joinMemberships?.map((row) => row.targetDocumentIds),
    extra.map((_row, index) => [`dynamic-candidate-${index}`]));
  console.log(JSON.stringify({ scenario: 'dynamic-membership-keys', count: 32, fallback, ...counts }));
}
