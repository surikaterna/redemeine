import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CommitProjectionSourceCommitResult, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, snapshot, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

type Scenario = 'recorded' | 'wrong-commit' | 'none' | 'fresh';
type Store = ProjectionSourceCommitStorePort<State>;

function observeAttempt(store: Store, compatibility: boolean, intervene: () => Promise<void>) {
  const outcomes: CommitProjectionSourceCommitResult[] = [];
  const port: Store = {
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    ...(compatibility ? {} : { sourceCommitSnapshotCapability: store.sourceCommitSnapshotCapability }),
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    async commitProjectionSourceCommit(request, observed) {
      assert.equal(observed === undefined, compatibility);
      if (outcomes.length === 0) {
        assert.deepEqual(request.finalDocuments.map(({ targetDocumentId }) => targetDocumentId), ['A']);
        await intervene();
      }
      const result = await store.commitProjectionSourceCommit(request, observed);
      outcomes.push(result);
      return result;
    }
  };
  return { port, outcomes };
}

function assertStoreOutcome(outcomes: CommitProjectionSourceCommitResult[], scenario: Scenario) {
  if (scenario === 'wrong-commit') {
    assert.equal(outcomes.length, 1);
    const [result] = outcomes;
    assert(result?.status === 'rejected' && result.category === 'terminal');
    assert.match(result.reason, /identity mismatch/);
    return;
  }
  assert.equal(outcomes.length, scenario === 'none' ? 2 : 1);
  if (scenario === 'none') {
    const [stale] = outcomes;
    assert(stale?.status === 'rejected' && stale.category === 'conflict');
  }
  const result = outcomes.at(-1);
  assert(result?.status === 'committed');
  assert.equal(result.replayed, scenario === 'recorded' ? true : undefined);
  const receipt = result.additionalWrites?.[0];
  assert.deepEqual(receipt?.targets.map(({ targetDocumentId }) => targetDocumentId), [scenario === 'fresh' ? 'A' : 'B']);
  assert.equal(receipt?.applicationId !== undefined, scenario === 'none');
}

export async function runValidReceiptRace(makeStore: () => Store, scenario: Scenario, compatibility: boolean) {
  const raw = makeStore();
  const strategy = scenario === 'none'
    ? { strategy: 'none', reason: 'fixture duplicate application', duplicateEffects: 'acknowledged' } as const : undefined;
  const operator = coordinator(fixtureOptions(raw));
  const boardA = randomUUID();
  await completed(operator, turn(boardA, 0, 'A', [['attach']], 'Board'));
  const event = turn(randomUUID(), 0, orderId, [['ordinary']]);
  const winnerOptions = fixtureOptions(makeStore(), [], strategy);
  const winner = coordinator({ ...winnerOptions, sourceOrder: { ...winnerOptions.sourceOrder,
    async advanceCoverage() { throw new Error('interrupted before advancing coverage'); } } });
  const { port, outcomes } = observeAttempt(raw, compatibility, async () => {
    if (scenario === 'fresh') return;
    await completed(operator, turn(boardA, 1, 'A', [['detach']], 'Board'));
    await completed(operator, turn(randomUUID(), 0, 'B', [['attach']], 'Board'));
    const winningEvent = scenario === 'wrong-commit' ? { ...event, commitId: randomUUID() } : event;
    assert.equal((await winner.process(winningEvent)).definitions[0]?.outcome.status, 'committed');
    assert.equal(await fixtureCoverage(winnerOptions, winningEvent), null);
  });
  const options = fixtureOptions(port, [], strategy);
  const result = await coordinator(options).process(event);
  assertStoreOutcome(outcomes, scenario);
  assert.equal(result.status, scenario === 'wrong-commit' ? 'terminal' : 'completed', JSON.stringify(result));
  if (scenario !== 'wrong-commit') {
    assert.equal(result.definitions[0]?.outcome.status, scenario === 'recorded' ? 'deduplicated' : 'committed');
  }
  const coverage = await fixtureCoverage(options, event);
  assert.equal(coverage, scenario === 'wrong-commit' ? null : 0);
  const state = await snapshot(raw, event.streamId, ['A', 'B']);
  assert.equal(state.ownRecordSequence, scenario === 'none' ? null : 0);
  assert.deepEqual(state.targets.map(({ state }) => state?.visits), scenario === 'fresh' ? [['root-attach', 'ordinary'], undefined]
    : [['root-attach', 'root-detach'], ['root-attach', 'ordinary', ...(scenario === 'none' ? ['ordinary'] : [])]]);
  console.log(JSON.stringify({ scenario: `valid-membership-receipt-${scenario}`, compatibility, status: result.status, coverage }));
}
