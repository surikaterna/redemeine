import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { JoinSeedProvenance, ProjectionSourceCommit, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { orderId, turn } from './joinMembershipFixture';
import { evidence, fixtureRuntime, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { complete, order } from './joinSeedScenarios';

function storeForMode(backend: Backend, compatibility: boolean): ProjectionSourceCommitStorePort<State> {
  const store = backend.store();
  return {
    joinMembershipCapability: store.joinMembershipCapability, joinSeedCapability: store.joinSeedCapability,
    projectionChangesCapability: store.projectionChangesCapability,
    sourceCommitSnapshotCapability: compatibility ? undefined : store.sourceCommitSnapshotCapability,
    loadProjectionSourceCommitSnapshot: (request) => store.loadProjectionSourceCommitSnapshot(request),
    commitProjectionSourceCommit(request, snapshot) {
      assert.equal(snapshot === undefined, compatibility);
      return store.commitProjectionSourceCommit(request, snapshot);
    }
  };
}

async function assertHistory(backend: Backend, expected: readonly [ProjectionSourceCommit, JoinSeedProvenance?][]) {
  const history = await backend.history();
  assert.equal(history.length, expected.length);
  for (const [commit, seed] of expected) {
    const matches = history.filter(({ commitId }) => commitId === commit.commitId);
    assert.equal(matches.length, 1);
    const transition = matches[0]!.targets[0]!.transitions[0]!;
    assert.equal(transition.eventId, commit.events[0].eventId);
    assert.deepEqual(transition.joinSeeds, seed ? [seed] : undefined);
  }
}

export async function reattachSeededEdge(backend: Backend, compatibility: boolean) {
  const source = randomUUID();
  const board = randomUUID();
  const attach = (sequence: number, payload: { seed?: boolean; detachFirst?: boolean; cancel?: boolean }) =>
    turn(board, sequence, 'A', [['attach', payload]], 'Board');
  const proof = (sequence: number) => evidence(orderId, 'projection', { kind: 'throughCommit', streamId: source, commitSequence: sequence });
  let reads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async () => {
    reads += 1;
    return { state: { booking: { total: reads * 30 } }, provenance: proof(reads) };
  }));
  const start = () => fixture.start(storeForMode(backend, compatibility));
  const edge = async (targets: string[], sequence?: number) => {
    const { row } = await read(backend, source, 'A');
    assert.deepEqual(row.targetDocumentIds, targets);
    assert.deepEqual(row.seeds, sequence === undefined ? undefined : [{ targetDocumentId: 'A', provenance: proof(sequence) }]);
  };
  const seeded = attach(0, { seed: true });
  await complete(start(), seeded);
  const idempotentPlain = attach(1, {});
  await complete(start(), idempotentPlain);
  const idempotent = attach(2, { seed: true });
  await complete(start(), idempotent);
  await edge(['A'], 1);
  assert.equal(reads, 1);

  const initialized = attach(3, { detachFirst: true, seed: true });
  await complete(start(), initialized);
  await edge(['A'], 2);
  assert.equal((await read(backend, source, 'A')).states[0]?.total, 60);
  assert.equal(await complete(start(), initialized), 'deduplicated');
  assert.equal(reads, 2);

  const plain = attach(4, { detachFirst: true });
  await complete(start(), plain);
  await edge(['A']);
  assert.equal(reads, 2);
  assert.equal(await complete(start(), plain), 'deduplicated');
  await edge(['A']);
  const delta = order(source, 0, [['delta', { amount: 7 }]]);
  await complete(start(), delta); // Within the old inclusive proof; the new edge must still apply it.
  const { states } = await read(backend, source, 'A');
  assert.equal(states[0]?.total, 67);
  assert.equal(states[0]?.effects.at(-1), 'delta:unseeded');
  assert.equal(reads, 2);

  const canceled = attach(5, { detachFirst: true, seed: true, cancel: true });
  await complete(start(), canceled);
  await edge([]);
  assert.equal(reads, 2);
  await assertHistory(backend, [[seeded, proof(1)], [idempotentPlain], [idempotent], [initialized, proof(2)], [plain], [delta], [canceled]]);
}
