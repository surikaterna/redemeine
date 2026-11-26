import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { evidence, fixtureRuntime, type Backend, type State, viewFixture } from './joinSeedFixture';
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
