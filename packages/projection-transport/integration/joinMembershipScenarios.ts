import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommit, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, path, routed, snapshot, type State, turn } from './joinMembershipFixture';

export async function completed(runtime: ReturnType<typeof coordinator>, commit: ProjectionSourceCommit) {
  const result = await runtime.process(commit);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return result;
}

async function expectMembers(store: ProjectionSourceCommitStorePort<State>, source: string, ids: string[]) {
  const row = (await snapshot(store, source)).joinMemberships?.[0];
  assert.deepEqual(row?.targetDocumentIds, ids);
  assert.notEqual(row?.revision, null);
}

export async function runRouting(makeStore: () => ProjectionSourceCommitStorePort<State>) {
  const store = makeStore();
  const s = randomUUID();
  const ct = (seq: number, events: Parameters<typeof turn>[3]) => turn(s, seq, orderId, events);
  const first = ct(0, [[routed, { targets: 'A', to: 'A' }], ['ordinary']]);
  const next = ct(1, [['ordinary']]);
  const options = fixtureOptions(store, [first, next]);
  let runtime = coordinator(options);
  assert.deepEqual((await completed(runtime, next)).processedSequences, [0, 1]);
  runtime = coordinator({ ...options, store: makeStore() });
  await completed(runtime, ct(2, [[routed, { targets: ['B', 'A', 'A'], to: 'B' }]]));
  await expectMembers(store, s, ['A', 'B']);
  await completed(runtime, ct(3, [['ordinary'], ['unlink', { only: 'B' }]]));
  await expectMembers(store, s, ['A']);
  await completed(runtime, ct(4, [[routed, { targets: 'B', from: 'A', to: 'B' }], ['ordinary']]));
  await expectMembers(store, s, ['B']);
  await completed(runtime, ct(5, [['unlink'], ['ordinary']]));
  await expectMembers(store, s, []);
  await completed(runtime, ct(6, [[routed, { targets: 'rejected', skip: true }], [routed, { targets: 'canceled', canceled: true }]]));
  await completed(runtime, ct(7, [[routed, { targets: 'unattached' }]]));
  await completed(runtime, ct(8, [['ordinary']]));
  await completed(runtime, turn(randomUUID(), 0, 'direct-id', [['direct']], 'Board'));
  const replay = await completed(runtime, first);
  assert.equal(replay.definitions[0]?.outcome.status, 'deduplicated');
  const state = await snapshot(store, s, ['A', 'B', 'rejected', 'canceled', 'unattached', 'direct-id']);
  assert.equal(state.ownRecordSequence, 8);
  assert.deepEqual(state.targets.map((target) => target.state?.visits ?? null), [
    ['routed', 'ordinary', 'ordinary', 'routed', 'ordinary', 'routed'],
    ['routed', 'ordinary', 'unlink', 'routed', 'ordinary', 'unlink'],
    null, null, ['routed'], ['direct']
  ]);
}

function wrapStore(store: ProjectionSourceCommitStorePort<State>, race: () => Promise<void>,
  compatibility: boolean) {
  let inject = true;
  let conflicts = 0;
  const wrapper: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    ...(compatibility ? {} : { sourceCommitSnapshotCapability: store.sourceCommitSnapshotCapability }),
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    async commitProjectionSourceCommit(request, observed) {
      if (inject) { inject = false; await race(); }
      const result = await store.commitProjectionSourceCommit(request, observed);
      if (result.status === 'rejected' && result.category === 'conflict') conflicts += 1;
      return result;
    }
  };
  return { wrapper, conflicts: () => conflicts };
}

export async function runRace(makeStore: () => ProjectionSourceCommitStorePort<State>, base: 'absent' | 'empty' | 'member' | 'aba',
  compatibility: boolean) {
  const otherStore = makeStore();
  const writer = coordinator(fixtureOptions(otherStore));
  const store = makeStore();
  const source = randomUUID();
  if (base === 'empty') await completed(writer, turn(randomUUID(), 0, orderId, [['ordinary']]));
  if (base === 'member' || base === 'aba') await completed(writer, turn(randomUUID(), 0, 'A', [['attach']], 'Board'));
  const { wrapper, conflicts } = wrapStore(store, async () => {
    if (base === 'aba') {
      for (const targetDocumentIds of [[], ['A']]) {
        const before = (await snapshot(otherStore, source)).joinMemberships![0]!;
        const result = await otherStore.commitProjectionSourceCommit({
          version: 1, mode: 'atomic-all', projectionName: 'boards', projectionGeneration: 'set-generation',
          commit: turn(randomUUID(), 0, orderId, [['ordinary']]), progress: { strategy: 'none' },
          finalDocuments: [], stagedLinks: [], joinMembershipFences: [{ ...path, expectedRevision: before.revision, targetDocumentIds }]
        });
        assert.equal(result.status, 'committed', JSON.stringify(result));
      }
    } else await completed(writer, turn(randomUUID(), 0, 'B', [['attach']], 'Board'));
  }, compatibility);
  const options = fixtureOptions(wrapper);
  const runtime = coordinator(options);
  const original = turn(source, 0, orderId, [['ordinary']]);
  await completed(runtime, original);
  assert.equal(conflicts(), 1);
  const current = await snapshot(store, source, ['A', 'B']);
  assert.equal(current.ownRecordSequence, 0);
  assert.deepEqual(current.joinMemberships?.[0]?.targetDocumentIds,
    base === 'member' ? ['A', 'B'] : base === 'aba' ? ['A'] : ['B']);
  for (const row of current.joinMemberships?.[0]?.targetDocumentIds ?? []) {
    assert.equal(current.targets.find(({ targetDocumentId }) => targetDocumentId === row)?.state?.visits
      .filter((visit) => visit === 'ordinary').length, 1);
  }
  assert.equal(await fixtureCoverage(options, original), 0);
  const proof = await store.loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: 'set-generation', targetDocumentIds: [], links: [], progressStrategy: 'none',
    changeIdentity: { sourceId: source, collection: 'join-changes', commitId: original.commitId, commitSequence: 0 }
  });
  assert.equal(proof.changeReceipt, 'committed');
}

export async function runDisjointAttach(makeStore: () => ProjectionSourceCommitStorePort<State>) {
  const store = makeStore();
  const writer = coordinator(fixtureOptions(makeStore()));
  const { wrapper, conflicts } = wrapStore(store, async () => {
    await completed(writer, turn(randomUUID(), 0, 'B', [['attach']], 'Board'));
  }, false);
  const runtime = coordinator(fixtureOptions(wrapper));
  const source = randomUUID();
  await completed(runtime, turn(source, 0, 'A', [['attach']], 'Board'));
  assert.equal(conflicts(), 1);
  await expectMembers(store, source, ['A', 'B']);
}

export async function runNone(store: ProjectionSourceCommitStorePort<State>) {
  const runtime = coordinator(fixtureOptions(store, [], { strategy: 'none', reason: 'synthetic redelivery', duplicateEffects: 'acknowledged' }));
  const source = randomUUID();
  const original = turn(source, 0, orderId, [[routed, { targets: 'A' }]]);
  await completed(runtime, original);
  await completed(runtime, turn(randomUUID(), 0, 'B', [['attach', { order: path.aggregateId }]], 'Board'));
  await completed(runtime, original);
  const state = await snapshot(store, source, ['A', 'B']);
  assert.equal(state.ownRecordSequence, null);
  assert.deepEqual(state.targets.map(({ state }) => state?.visits), [['routed', 'routed'], ['root-attach', 'routed']]);
}

export async function runFirstCandidateWrite(store: ProjectionSourceCommitStorePort<State>) {
  const runtime = coordinator(fixtureOptions(store));
  const source = randomUUID();
  const first = turn(source, 0, orderId, [[routed, { targets: 'vetoed', skip: true }], [routed, { targets: 'eligible' }]]);
  await completed(runtime, first);
  await completed(runtime, turn(source, 1, orderId, [['ordinary']]));
  const state = await snapshot(store, source, ['eligible', 'vetoed']);
  assert.deepEqual(state.targets.map((target) => target.state?.visits ?? null), [['routed'], null]);
  assert.deepEqual(state.joinMemberships?.[0]?.targetDocumentIds, []);
}
