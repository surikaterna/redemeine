import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { evidence, fixtureRuntime, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { complete, order, root } from './joinSeedScenarios';
import { orderId } from './joinMembershipFixture';

export async function recoverSeedReceipt(backend: Backend, compatibility: boolean, corrupt: () => Promise<void> = async () => {}) {
  const underlying = backend.store();
  const streamId = randomUUID();
  const proof = evidence(orderId, 'projection', { kind: 'throughCommit', streamId, commitSequence: 0 });
  let seedReads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    assert.equal(id, proof.documentId);
    return { state: { booking: { total: ++seedReads * 10 } }, provenance: proof };
  }));
  const { options } = fixture;
  const winner = createProjectionCommitCoordinator({
    ...options, store: backend.store(), sourceOrder: {
      ...options.sourceOrder,
      async advanceCoverage() { throw new Error('Interrupted after durable projection commit.'); }
    }
  });
  const commit = order(streamId, 0, [['assign', { to: 'A', amount: 1 }]]);
  let attempts = 0;
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: underlying.joinMembershipCapability, joinSeedCapability: underlying.joinSeedCapability,
    projectionChangesCapability: underlying.projectionChangesCapability,
    sourceCommitSnapshotCapability: compatibility ? undefined : underlying.sourceCommitSnapshotCapability,
    loadProjectionSourceCommitSnapshot: underlying.loadProjectionSourceCommitSnapshot.bind(underlying),
    async commitProjectionSourceCommit(request, snapshot) {
      assert.equal(++attempts, 1);
      assert.equal(snapshot === undefined, compatibility);
      assert.deepEqual(request.finalDocuments.map(({ targetDocumentId }) => targetDocumentId), ['A']);
      await complete(fixture.start(), root('B', false));
      const result = await winner.process(commit);
      assert.equal(result.definitions[0]?.outcome.status, 'committed');
      assert.equal(fixture.coverage.has(streamId), false);
      await corrupt();
      const recovered = await underlying.commitProjectionSourceCommit(request, snapshot);
      assert(recovered.status === 'committed' && recovered.replayed);
      assert.deepEqual(recovered.additionalWrites?.[0]?.targets.map(({ targetDocumentId }) => targetDocumentId), ['A', 'B']);
      return recovered;
    }
  };
  assert.equal(await complete(fixture.start(port), commit), 'deduplicated');
  assert.equal(fixture.coverage.get(streamId), 0);
  assert.equal(seedReads, 2); // One for each A plan; the winning B edge was already forward-only.
  const matching = (await backend.history()).filter(({ commitId }) => commitId === commit.commitId);
  assert.equal(matching.length, 1);
  assert.deepEqual(matching[0]?.targets.map(({ transitions }) => transitions[0]?.joinSeeds), [[proof], undefined]);
  console.log(JSON.stringify({ scenario: 'initialized receipt recovery', compatibility, seedReads, coverage: 0 }));
}

type ProofCase = 'exact' | 'exact-malformed' | 'late-exact' | 'wrong' | 'missing' | 'unreadable' | 'unacknowledged' | 'off';

export async function providerReceiptRace(backend: Backend, compatibility: boolean, proofCase: ProofCase) {
  const underlying = backend.store();
  const streamId = randomUUID();
  const commit = order(streamId, 0, [['assign', { to: 'A', amount: 3 }]]);
  let resume!: () => void;
  let entered!: () => void;
  const release = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  let receiptReads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    if (++reads === 1) {
      entered();
      await release;
      if (proofCase === 'exact-malformed') return { state: { booking: { total: 12 } }, provenance: evidence(id, 'projection',
        { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
      if (proofCase === 'wrong') return { state: { booking: { total: 12 } }, provenance: evidence('wrong-id', 'projection', { kind: 'unknown' }) };
      throw new Error('Provider unavailable.');
    }
    return { state: { booking: { total: 12 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId, commitSequence: 0 }) };
  }), proofCase !== 'off');
  const applyWinner = async () => {
    const winner = createProjectionCommitCoordinator({ ...fixture.options, store: backend.store(), sourceOrder: {
      ...fixture.options.sourceOrder, async advanceCoverage() { throw new Error('Interrupted before coverage.'); }
    } });
    const contender = proofCase === 'wrong' ? order(streamId, 0, [['assign', { to: 'A', amount: 3 }]]) : commit;
    assert.equal((await winner.process(contender)).definitions[0]?.outcome.status, 'committed');
  };
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: underlying.joinMembershipCapability, joinSeedCapability: underlying.joinSeedCapability,
    projectionChangesCapability: underlying.projectionChangesCapability,
    sourceCommitSnapshotCapability: compatibility ? undefined : underlying.sourceCommitSnapshotCapability,
    async loadProjectionSourceCommitSnapshot(req) {
      if (req.changeIdentity && req.progressStrategy === 'none' && !req.links.length && !req.targetDocumentIds.length) {
        receiptReads += 1;
        if (proofCase === 'unreadable') throw new Error('Receipt unreadable.');
        if (proofCase === 'unacknowledged') return { targets: [], links: [], ownRecordSequence: null };
      }
      const observation = await underlying.loadProjectionSourceCommitSnapshot(req);
      if (proofCase === 'late-exact' && receiptReads === 1 && req.targetDocumentIds.includes('A')) await applyWinner();
      return observation;
    },
    async commitProjectionSourceCommit() { assert.fail('The failed provider must not submit a write.'); }
  };
  const main = fixture.start(port).process(commit);
  await ready;
  const wins = proofCase !== 'missing';
  try {
    if (wins && proofCase !== 'late-exact') await applyWinner();
  } finally { resume(); }
  const outcome = await main;
  const exact = proofCase === 'exact' || proofCase === 'exact-malformed' || proofCase === 'late-exact';
  const status = exact ? 'completed' : proofCase === 'wrong' ? 'terminal' : 'retryable';
  assert.equal(outcome.status, status, JSON.stringify(outcome));
  assert.equal(receiptReads, proofCase === 'off' ? 0 : proofCase === 'missing' || proofCase === 'late-exact' ? 2 : 1);
  assert.equal(fixture.coverage.get(streamId), exact ? 0 : undefined);
  assert.equal((await read(backend, streamId, 'A')).states[0]?.total, wins ? 12 : undefined);
  assert.equal((await backend.history()).length, wins && proofCase !== 'off' ? 1 : 0);
  if (exact) assert.equal(outcome.definitions[0]?.outcome.status, 'deduplicated');
  if (proofCase === 'wrong') assert.match('reason' in outcome ? outcome.reason : '', /receipt|identity mismatch/);
  if (proofCase === 'unreadable' || proofCase === 'unacknowledged') assert.equal(outcome.definitions[0]?.outcome.status, 'ambiguous');
}
