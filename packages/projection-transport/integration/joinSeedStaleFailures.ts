import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { CommandStartedEvent, MongoClient } from 'mongodb';
import { turn } from './joinMembershipFixture';
import { evidence, fixtureRuntime, generation, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { complete, order, root } from './joinSeedScenarios';

function pauseFirstRead() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { enter = resolve; }),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    enter: () => enter(), release: () => release()
  };
}

function compatibilityPort(store: ProjectionSourceCommitStorePort<State>, compatibility: boolean): ProjectionSourceCommitStorePort<State> {
  if (!compatibility) return store;
  return {
    joinMembershipCapability: store.joinMembershipCapability, joinSeedCapability: store.joinSeedCapability,
    projectionChangesCapability: store.projectionChangesCapability,
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    commitProjectionSourceCommit: store.commitProjectionSourceCommit.bind(store)
  };
}

export async function caughtBinding(backend: Backend, compatibility: boolean) {
  const source = randomUUID();
  let rejected = 0;
  let reads = 0;
  const fixture = viewFixture(async () => { reads += 1; return null; }, true);
  const joinStreams = fixture.definition.joinStreams!.map((stream) => ({ ...stream,
    handlers: Object.fromEntries(Object.entries(stream.handlers).map(([key, handler]) => [key, (...args: Parameters<typeof handler>) => {
      try { handler(...args); } catch (error) {
        assert.match(String(error), /registered binding/);
        rejected += 1;
      }
    }])) }));
  const runtime = fixtureRuntime(backend, { ...fixture, definition: { ...fixture.definition, joinStreams } });
  await complete(runtime.start(compatibilityPort(backend.store(), compatibility)), order(source, 0, [['assign', { to: 'A', amount: 10 }]]));
  const actual = await read(backend, source, 'A');
  assert.equal(rejected, 1);
  assert.equal(reads, 0);
  assert.deepEqual(actual.row.targetDocumentIds, []);
  assert.equal(actual.row.seeds, undefined);
  assert.equal(actual.progress, 0);
  assert((await backend.history()).every((receipt) => receipt.targets.every((target) =>
    target.transitions.every((entry) => entry.joinSeeds === undefined))));
}

export async function staleProvider(backend: Backend, settings: { compatibility: boolean; recording: boolean; wrongStream: boolean;
  forwardWinner: boolean }) {
  const source = randomUUID();
  const pause = pauseFirstRead();
  let reads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    reads += 1;
    pause.enter();
    await pause.wait;
    if (!settings.wrongStream) throw new Error('Provider unavailable.');
    return { state: { booking: { total: 50 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
  }), settings.recording);
  const worker = fixture.start(compatibilityPort(backend.store(), settings.compatibility));
  const pending = worker.process(order(source, 0, [['assign', { to: 'A', amount: 10 }]]));
  await pause.entered;
  try {
    if (settings.forwardWinner) await complete(worker, root('A', false));
  } finally { pause.release(); }
  const outcome = await pending;
  assert.equal(reads, 1);
  const actual = await read(backend, source, 'A');
  assert.equal(actual.row.seeds, undefined);
  if (!settings.forwardWinner) {
    assert.equal(outcome.status, settings.wrongStream ? 'terminal' : 'retryable');
    assert.equal(actual.progress, null);
    assert.equal(fixture.coverage.has(source), false);
    assert.deepEqual(actual.states, [null]);
    return;
  }
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.definitions[0]?.outcome.status, 'committed');
  assert.equal(actual.progress, 0);
  assert.equal(fixture.coverage.get(source), 0);
  assert.deepEqual(actual.row.targetDocumentIds, ['A']);
  assert.deepEqual(actual.states[0], { total: 0, effects: ['attach', 'assign:unseeded', 'after:0'] });
}

export async function rerouteFailedSeed(backend: Backend, compatibility: boolean) {
  const pause = pauseFirstRead();
  const ids: string[] = [];
  const fixture = viewFixture(async (id) => {
    ids.push(id);
    if (id === 'X') {
      pause.enter();
      await pause.wait;
      throw new Error('X provider unavailable.');
    }
    return { state: { booking: { total: 50 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
  });
  const from = fixture.definition.fromStream;
  const original = from.handlers.attach!;
  const definition = { ...fixture.definition, fromStream: { ...from, handlers: { ...from.handlers,
    attach(draft: Parameters<typeof original>[0], event: Parameters<typeof original>[1], ctx: Parameters<typeof original>[2]) {
      original(draft, event.payload.seed ? { ...event, payload: { ...event.payload, ids: [draft.total === 1 ? 'X' : 'Y'] } } : event, ctx);
    }
  } } };
  const runtime = fixtureRuntime(backend, { ...fixture, definition });
  const store = backend.store();
  const worker = runtime.start(compatibilityPort(store, compatibility));
  const board = (total: number) => turn(randomUUID(), 0, 'A', [['attach', { ids: ['unrelated'], total }]], 'Board');
  await complete(worker, board(1));
  const attach = root('A', true);
  const pending = complete(worker, attach);
  await pause.entered;
  try { await complete(worker, board(2)); } finally { pause.release(); }
  assert.equal(await pending, 'committed');
  assert.deepEqual(ids, ['X', 'Y']);
  const snapshot = await store.loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: generation, joinMembership: 'set-v1', joinSeedVersion: 1,
    targetDocumentIds: ['A'], links: ['X', 'Y'].map((aggregateId) => ({ aggregateType: 'Order', aggregateId })),
    progressStrategy: 'own_record', sourceId: attach.streamId
  });
  assert.equal(snapshot.targets[0]?.state?.total, 50);
  assert.deepEqual(snapshot.joinMemberships?.map((row) => row.targetDocumentIds), [[], ['A']]);
  assert.equal(snapshot.joinMemberships?.[1]?.seeds?.[0]?.provenance.aggregateId, 'Y');
}

export async function staleReceiptSize(backend: Backend, client: MongoClient, compatibility: boolean, scenario: 'fresh' | 'shrink' | 'winner') {
  const source = randomUUID();
  const pause = pauseFirstRead();
  let reads = 0;
  const fixture = viewFixture(async (id) => {
    if (++reads === 1) {
      pause.enter();
      await pause.wait;
    }
    return { state: { booking: { total: 50 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: source, commitSequence: 0 }) };
  });
  const joinStreams = fixture.definition.joinStreams!.map((stream) => ({ ...stream,
    handlers: Object.fromEntries(Object.entries(stream.handlers).map(([key, handler]) => [key, (...args: Parameters<typeof handler>) => {
      handler(...args);
      if (args[1].type === 'assign' && args[0].total === 1) args[0].effects.push('X'.repeat(16 * 1024 * 1024));
    }])) }));
  const runtime = fixtureRuntime(backend, { ...fixture, definition: { ...fixture.definition, joinStreams } });
  const worker = runtime.start(compatibilityPort(backend.store(), compatibility));
  const board = (total: number) => turn(randomUUID(), 0, 'A', [['attach', { ids: ['unrelated'], total }]], 'Board');
  await complete(worker, board(1));
  const commit = order(source, 0, [['assign', { to: 'A', amount: 10 }]]);
  const pending = worker.process(commit);
  await pause.entered;
  const mutations: string[] = [];
  const record = ({ commandName }: CommandStartedEvent) => {
    if (['insert', 'update', 'delete', 'bulkWrite', 'findAndModify'].includes(commandName)) mutations.push(commandName);
  };
  try {
    if (scenario !== 'fresh') await complete(worker, board(2));
    if (scenario === 'winner') {
      const winner = createProjectionCommitCoordinator({ ...runtime.options, store: backend.store(), sourceOrder: {
        ...runtime.options.sourceOrder, async advanceCoverage() { throw new Error('Interrupted after the durable receipt.'); }
      } });
      assert.equal((await winner.process(commit)).definitions[0]?.outcome.status, 'committed');
    }
  } finally { client.on('commandStarted', record); pause.release(); }
  const outcome = await pending.finally(() => client.off('commandStarted', record));
  assert.equal(reads, scenario === 'winner' ? 2 : 1);
  const actual = await read(backend, source, 'A');
  if (scenario !== 'fresh') {
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    assert.equal(actual.states[0]?.total, 50);
    assert.deepEqual(actual.row.targetDocumentIds, ['A']);
    assert.equal(actual.progress, 0);
  } else {
    assert.equal(outcome.status, 'terminal', JSON.stringify(outcome));
    assert.match('reason' in outcome ? outcome.reason : '', /16 MiB physical BSON/);
    assert.deepEqual(mutations, []);
    assert.equal(actual.states[0]?.total, 1);
    assert.deepEqual(actual.row.targetDocumentIds, []);
    assert.equal(actual.progress, null);
  }
  if (scenario === 'winner') {
    assert.equal(outcome.definitions[0]?.outcome.status, 'deduplicated');
    assert.deepEqual(mutations, []);
    assert.equal((await backend.history()).filter((receipt) => receipt.commitId === commit.commitId).length, 1);
  }
  assert.equal(runtime.coverage.get(source), scenario === 'fresh' ? undefined : 0);
}
