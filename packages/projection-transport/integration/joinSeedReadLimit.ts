import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { turn } from './joinMembershipFixture';
import { evidence, fixtureRuntime, read, type Backend, viewFixture } from './joinSeedFixture';
import { complete } from './joinSeedScenarios';

const ids = Array.from({ length: 64 }, (_, index) => `Order-${index}`);
const board = (total: number) => turn(randomUUID(), 0, 'A', [['attach', { ids: ['unrelated'], total }]], 'Board');

function fixtureWithLimit(readOne: Parameters<typeof viewFixture>[0]) {
  const fixture = viewFixture(readOne);
  const from = fixture.definition.fromStream;
  const attach = from.handlers.attach!;
  return { ...fixture, definition: { ...fixture.definition, fromStream: { ...from, handlers: { ...from.handlers,
    attach(draft: Parameters<typeof attach>[0], event: Parameters<typeof attach>[1], ctx: Parameters<typeof attach>[2]) {
      if (event.payload.cancel) draft.effects.push(draft.total === 1 ? 'long' : 'short');
      const selected = Array.isArray(event.payload.ids) && event.payload.ids[0] === 'choose';
      attach(draft, !selected ? event : {
        ...event, payload: { seed: true, ids: draft.effects.includes('long') ? ids : ids.slice(0, 1) }
      }, ctx);
    }
  } } } };
}

type Case = 'fits-on-refresh' | 'genuine-limit' | 'late-winner';

export async function plannedSeedReadLimit(backend: Backend, compatibility: boolean, scenario: Case) {
  const source = randomUUID();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const fixture = fixtureWithLimit(async (id) => {
    calls.push(id);
    if (calls.length === 1) { enter(); await wait; }
    return { state: { booking: { total: 50 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
  });
  const runtime = fixtureRuntime(backend, fixture);
  const commit = turn(source, 0, 'A', [
    ['attach', { ids: ['first', ...ids], cancel: true }],
    ['attach', { ids: ['first'], seed: true }],
    ['attach', { ids: ['choose'], seed: true }]
  ], 'Board');
  const store = backend.store();
  const setup = runtime.start();
  const winner = createProjectionCommitCoordinator({ ...runtime.options, store: backend.store(), sourceOrder: {
    ...runtime.options.sourceOrder, async advanceCoverage() { throw new Error('Interrupted after writing exact receipt.'); }
  } });
  let fullReadsAfterWait = 0;
  let receiptOnly = 0;
  let resumed = false;
  let submissions = 0;
  const worker = runtime.start({
    joinMembershipCapability: store.joinMembershipCapability, joinSeedCapability: store.joinSeedCapability,
    projectionChangesCapability: store.projectionChangesCapability,
    sourceCommitSnapshotCapability: compatibility ? undefined : store.sourceCommitSnapshotCapability,
    async loadProjectionSourceCommitSnapshot(request) {
      const observed = await store.loadProjectionSourceCommitSnapshot(request);
      if (request.changeIdentity && request.progressStrategy === 'none') receiptOnly += 1;
      if (resumed && request.sourceId === source && request.targetDocumentIds.length && ++fullReadsAfterWait === 1
        && scenario === 'late-winner') {
        await complete(setup, board(2));
        assert.equal((await winner.process(commit)).definitions[0]?.outcome.status, 'committed');
        assert.equal(runtime.coverage.has(source), false);
      }
      return observed;
    },
    async commitProjectionSourceCommit(request, snapshot) {
      submissions += 1;
      return store.commitProjectionSourceCommit(request, snapshot);
    }
  });
  await complete(setup, board(1));
  const pending = worker.process(commit);
  await entered;
  try {
    if (scenario === 'fits-on-refresh') await complete(setup, board(2));
  } finally { resumed = true; release(); }
  const result = await pending;
  const actual = await read(backend, source, 'A');
  assert.deepEqual(calls, scenario === 'genuine-limit' ? ['first'] : scenario === 'late-winner' ? ['first', 'first', ids[0]] : ['first', ids[0]]);
  assert.equal(submissions, scenario === 'fits-on-refresh' ? 1 : 0);
  assert.equal(fullReadsAfterWait, scenario === 'fits-on-refresh' ? 2 : 1);
  assert.equal(receiptOnly, scenario === 'fits-on-refresh' ? (compatibility ? 0 : 1) : compatibility ? 1 : 2);
  if (scenario === 'genuine-limit') {
    assert.equal(result.status, 'terminal');
    assert.match(result.reason, /seed read count exceeds capacity/);
    assert.equal(actual.progress, null);
    assert.equal(actual.states[0]?.total, 1);
    assert.equal(runtime.coverage.has(source), false);
  } else {
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.definitions[0]?.outcome.status, scenario === 'late-winner' ? 'deduplicated' : 'committed');
    assert.equal(actual.states[0]?.total, 50);
    assert.equal(actual.progress, 0);
    assert.equal(runtime.coverage.get(source), 0);
  }
  assert.equal((await backend.history()).filter(({ commitId }) => commitId === commit.commitId).length, scenario === 'genuine-limit' ? 0 : 1);
  console.log(JSON.stringify({ scenario: `seed-read-limit:${scenario}`, compatibility, calls, fullReadsAfterWait, receiptOnly, submissions }));
}
