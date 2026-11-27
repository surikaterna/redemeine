import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import type { CommandStartedEvent, MongoClient } from 'mongodb';
import { evidence, fixtureRuntime, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { orderId, turn } from './joinMembershipFixture';
import { complete, order, root } from './joinSeedScenarios';

function observedPort(backend: Backend, compat = false) {
  const store = backend.store();
  const counts = { snapshots: 0, writeAttempts: 0, receiptOnly: 0 };
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: store.joinMembershipCapability, joinSeedCapability: store.joinSeedCapability,
    projectionChangesCapability: store.projectionChangesCapability,
    sourceCommitSnapshotCapability: compat ? undefined : store.sourceCommitSnapshotCapability,
    async loadProjectionSourceCommitSnapshot(request) {
      counts.snapshots += 1;
      if (request.progressStrategy === 'none' && request.changeIdentity) counts.receiptOnly += 1;
      return store.loadProjectionSourceCommitSnapshot(request);
    },
    async commitProjectionSourceCommit(request, snapshot) {
      counts.writeAttempts += 1;
      return store.commitProjectionSourceCommit(request, snapshot);
    }
  };
  return { port, counts };
}

export async function scaleReadSet(backend: Backend, size: number, compat: boolean, client?: MongoClient) {
  const { port, counts } = observedPort(backend, compat);
  const ids = Array.from({ length: size }, (_, index) => `seed-${index}`);
  let reads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    reads += 1;
    return { state: { booking: { total: 8 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
  }));
  const commit = turn(randomUUID(), 0, 'A', [['attach', { cancel: true, ids }],
    ...ids.map((id): ['attach', { seed: true; ids: string[] }] => ['attach', { seed: true, ids: [id] }])], 'Board');
  const commands = { views: 0, memberships: 0, progress: 0, receipts: 0, commits: 0, writes: 0, total: 0 };
  function record({ commandName, command }: CommandStartedEvent) {
    commands.total += 1;
    if (commandName === 'insert' || commandName === 'update') commands.writes += 1;
    if (commandName === 'commitTransaction') commands.commits += 1;
    if (commandName !== 'find') return;
    if (command.find === 'boards') commands.views += 1;
    if (command.find === 'memberships') commands.memberships += 1;
    if (command.find === 'progress') commands.progress += 1;
    if (command.find === 'changes') commands.receipts += 1;
  }
  client?.on('commandStarted', record);
  try { await complete(fixture.start(port), commit); } finally { client?.off('commandStarted', record); }
  assert.equal(counts.snapshots, compat ? 3 + size : 3);
  assert.equal(counts.receiptOnly, 0);
  assert.equal(counts.writeAttempts, 1);
  assert.equal(reads, size);
  if (client) {
    assert.equal(commands.views, compat ? 3 + size : 2);
    assert.equal(commands.memberships, compat ? 2 + size : 1);
    assert.equal(commands.receipts, compat ? 3 + size : 0);
    assert.equal(commands.writes, 4);
    assert.equal(commands.total, compat ? 29 + (size - 1) * 5 : 18);
  }
  assert.equal((await backend.history())[0]?.targets[0]?.transitions.flatMap((t) => t.joinSeeds ?? []).length, size);
  console.log(JSON.stringify({ scenario: 'join seed read-set scale', backend: client ? 'mongo' : 'memory', size, compat, reads, ...counts, commands }));
}

export async function negativeTargetFence(backend: Backend) {
  const { port, counts } = observedPort(backend);
  const source = randomUUID();
  let reads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    reads += 1;
    return { state: { booking: { total: 8 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: source, commitSequence: 0 }) };
  }));
  await complete(fixture.start(port), order(source, 0, [
    ['assign', { to: 'missing', skip: true, amount: 1 }], ['assign', { to: 'A', amount: 1 }]
  ]));
  assert.equal(reads, 1);
  assert.deepEqual(counts, { snapshots: 3, writeAttempts: 1, receiptOnly: 0 });
  assert.deepEqual((await read(backend, source, 'missing', 'A')).states.map((state) => state?.total), [undefined, 8]);
}

export async function staleUnchangedTarget(backend: Backend) {
  const { port, counts } = observedPort(backend);
  const source = randomUUID();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    enter();
    await wait;
    return { state: { booking: { total: 8 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: source, commitSequence: 0 }) };
  }));
  const changeB = (total: number) => turn(randomUUID(), 0, 'B', [['attach', { ids: ['unrelated'], total }]], 'Board');
  await complete(fixture.start(), changeB(40));
  const main = complete(fixture.start(port), order(source, 0, [
    ['assign', { to: 'B', skip: true, amount: 1 }], ['assign', { to: 'A', amount: 1 }]
  ]));
  await entered;
  try {
    await complete(fixture.start(), changeB(41)); // only B changes; the Order read set's membership is untouched
  } finally { release(); }
  await main;
  assert.deepEqual(counts, { snapshots: 3, writeAttempts: 2, receiptOnly: 0 });
  assert.deepEqual((await read(backend, source, 'A', 'B')).states.map((state) => state?.total), [8, 41]);
}

export async function pausedCrossStream(backend: Backend) {
  const source = randomUUID();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fixture = fixtureRuntime(backend, viewFixture(async (id) => {
    enter();
    await wait;
    return { state: { booking: { total: 10 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: source, commitSequence: 0 }) };
  }));
  const worker = fixture.start();
  await complete(worker, root('adopted-forward', false));
  await complete(worker, order(source, 0, [['delta', { amount: 1 }]]));
  const attach = complete(worker, root('initialized', true));
  await entered;
  try {
    await complete(worker, order(source, 1, [['delta', { amount: 4 }]]));
    assert.equal(fixture.coverage.get(source), 1);
    assert.equal((await read(backend, source, 'initialized')).states[0], null);
  } finally { release(); }
  await attach;
  await complete(worker, order(source, 2, [['delta', { amount: 8 }]]));
  const { row, states } = await read(backend, source, 'adopted-forward', 'initialized');
  assert.deepEqual(states.map((state) => state?.total), [13, 18]); // seq 1 is not backfilled into the initialized target
  assert.deepEqual(row.seeds?.map((edge) => [edge.targetDocumentId, edge.provenance.aggregateId]), [['initialized', orderId]]);
}
