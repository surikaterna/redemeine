import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, routed, snapshot, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

type Store = ProjectionSourceCommitStorePort<State>;
type Case = 'winner' | 'winner-after-missing' | 'capacity-released' | 'fresh' | 'wrong-commit' | 'unreadable' | 'unacknowledged' | 'none';
const ids = Array.from({ length: 1024 }, (_, index) => `member-${String(index).padStart(4, '0')}`);
const board = (id: string, events: Parameters<typeof turn>[3]) => turn(randomUUID(), 0, id, events, 'Board');

async function seed(store: Store) {
  await completed(coordinator(fixtureOptions(store)), turn(randomUUID(), 0, orderId, [[routed, { targets: ids, attachAll: true }]]));
}

function racePort(raw: Store, compatibility: boolean, scenario: Case, intervene: () => Promise<void>, union: boolean) {
  const counts = { reads: 0, probes: 0, writes: 0 };
  let stale = false;
  const store: Store = {
    joinMembershipCapability: raw.joinMembershipCapability, projectionChangesCapability: raw.projectionChangesCapability,
    ...(compatibility ? {} : { sourceCommitSnapshotCapability: raw.sourceCommitSnapshotCapability }),
    async loadProjectionSourceCommitSnapshot(request) {
      ++counts.reads;
      const proofOnly = request.changeIdentity && !request.joinMembership && request.progressStrategy === 'none';
      if (proofOnly) {
        ++counts.probes;
        if (scenario === 'unreadable') throw new Error('receipt read unavailable');
      }
      const loaded = await raw.loadProjectionSourceCommitSnapshot(request);
      const canIntervene = union ? request.links.length > 0 : request.targetDocumentIds.length > 0 && request.links.length > 0;
      if (canIntervene && !stale) {
        stale = true;
        if (scenario === 'winner' || scenario === 'wrong-commit') await intervene();
      }
      if (proofOnly && counts.probes === 1 && (scenario === 'winner-after-missing' || scenario === 'capacity-released')) {
        assert.equal(loaded.changeReceipt, 'missing');
        await intervene();
      }
      if (!proofOnly || scenario !== 'unacknowledged') return loaded;
      const { changeReceipt: _proof, ...unacknowledged } = loaded;
      return unacknowledged;
    },
    commitProjectionSourceCommit(request, observed) {
      ++counts.writes;
      return raw.commitProjectionSourceCommit(request, observed);
    }
  };
  return { store, counts };
}

export async function runCapacityRace(makeStore: () => Store, compatibility: boolean, scenario: Case, union = false) {
  const raw = makeStore();
  await seed(raw);
  // The selector is valid on its own; only the union with the saved set exceeds capacity.
  const input = union ? turn(randomUUID(), 0, orderId, [[routed, { targets: 'extra', skip: true }]]) : board('extra', [['attach']]);
  const winnerOptions = fixtureOptions(makeStore());
  const winner = coordinator({ ...winnerOptions, sourceOrder: { ...winnerOptions.sourceOrder,
    async advanceCoverage() { throw new Error('interrupted before advancing coverage'); } } });
  const { store, counts } = racePort(raw, compatibility, scenario, async () => {
    await completed(coordinator(fixtureOptions(makeStore())), board(ids[0]!, [['detach']]));
    if (scenario !== 'capacity-released') {
      const winningInput = scenario === 'wrong-commit' ? { ...input, commitId: randomUUID() } : input;
      assert.equal((await winner.process(winningInput)).definitions[0]?.outcome.status, 'committed');
      assert.equal(await fixtureCoverage(winnerOptions, winningInput), null);
    }
  }, union);
  const options = fixtureOptions(store, [], scenario === 'none'
    ? { strategy: 'none', reason: 'fixture', duplicateEffects: 'acknowledged' } : undefined);
  const result = await coordinator(options).process(input);
  const winnerCommitted = scenario === 'winner' || scenario === 'winner-after-missing';
  const applied = winnerCommitted || scenario === 'capacity-released';
  const changed = applied || scenario === 'wrong-commit';
  const uncertain = scenario === 'unreadable' || scenario === 'unacknowledged';
  assert.equal(result.status, applied ? 'completed' : uncertain ? 'retryable' : 'terminal', JSON.stringify(result));
  assert.equal(result.definitions[0]?.outcome.status, winnerCommitted ? 'deduplicated'
    : scenario === 'capacity-released' ? 'committed' : uncertain ? 'ambiguous' : 'terminal');
  if (result.status === 'terminal') assert.match(result.reason, scenario === 'wrong-commit' ? /identity mismatch/ : /count exceeds capacity/);
  assert.equal(await fixtureCoverage(options, input), applied ? 0 : null);
  assert.equal(counts.writes, scenario === 'capacity-released' ? 1 : 0);
  assert.equal(counts.probes, scenario === 'none' ? 0 : scenario === 'fresh' ? 2 : 1);
  assert(counts.reads <= 8, JSON.stringify(counts));
  const final = await snapshot(raw, input.streamId, ['extra']);
  assert.equal(final.ownRecordSequence, changed ? 0 : null);
  assert.deepEqual(final.joinMemberships?.[0]?.targetDocumentIds,
    changed ? union ? ids.slice(1) : ['extra', ...ids.slice(1)] : ids);
  assert.deepEqual(final.targets[0]?.state?.visits, changed && !union ? ['root-attach'] : undefined);
  console.log(JSON.stringify({ scenario: `capacity-${scenario}`, compatibility, union, status: result.status, ...counts }));
}

export async function runEventLocalCapacity(store: Store) {
  await seed(store);
  const options = fixtureOptions(store);
  const runtime = coordinator(options);
  const input = board('extra', [['attach', { cancel: true }], ['direct']]);
  await completed(runtime, input);
  const final = await snapshot(store, input.streamId, ['extra']);
  assert.deepEqual(final.targets[0]?.state?.visits, ['root-attach', 'direct']);
  assert.deepEqual(final.joinMemberships?.[0]?.targetDocumentIds, ids);
  const uncanceledEvent = board('late', [['attach'], ['detach']]);
  const rejected = await runtime.process(uncanceledEvent);
  assert.equal(rejected.status, 'terminal', JSON.stringify(rejected));
  assert.match(rejected.reason ?? '', /count exceeds capacity/);
  assert.equal(await fixtureCoverage(options, uncanceledEvent), null);
  const unchanged = await snapshot(store, uncanceledEvent.streamId, ['late']);
  assert.equal(unchanged.targets[0]?.state, null);
  assert.deepEqual(unchanged.joinMemberships, final.joinMemberships);
}
