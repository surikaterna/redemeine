import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateProjectionSourceCommit, type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator, type ProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { orderId, turn } from './joinMembershipFixture';
import { evidence, fixtureRuntime, read, snapshotFixture, type Backend, type State, viewFixture } from './joinSeedFixture';

export const root = (id: string, seed: boolean, cancel = false) => turn(randomUUID(), 0, id, [['attach', { seed, cancel }]], 'Board');
export const order = (source: string, sequence: number, events: Parameters<typeof turn>[3]) => turn(source, sequence, orderId, events);

export async function complete(runtime: ProjectionCommitCoordinator, commit: Parameters<ProjectionCommitCoordinator['process']>[0]) {
  const result = await runtime.process(commit);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return result.definitions[0]!.outcome.status;
}

export async function proven(backend: Backend, supplied?: { streamId: string; readOne: Parameters<typeof viewFixture>[0] }) {
  const source = supplied?.streamId ?? randomUUID();
  const proof = evidence(orderId, 'projection', { kind: 'throughCommit', streamId: source, commitSequence: 1 });
  let reads = 0;
  const fixture = fixtureRuntime(backend, viewFixture(async (id, signal) => {
    reads += 1;
    return supplied ? supplied.readOne(id, signal) : { state: { booking: { total: 30 } }, provenance: proof };
  }));
  let runtime = fixture.start();
  await complete(runtime, root('cancelled', true, true));
  await complete(runtime, root('forward', false));
  assert.equal(reads, 0);
  const start = order(source, 0, [['assign', { to: 'a', amount: 12 }], ['delta', { amount: 4 }]]);
  await complete(runtime, start);
  const seeded = await read(backend, source, 'a', 'forward');
  assert.deepEqual(seeded.states[0], { total: 30, effects: ['assign:unseeded', 'view:covered', 'after:30', 'delta:covered'] });
  assert.equal(seeded.states[1]?.total, 4);
  assert.deepEqual(seeded.row.seeds, [{ targetDocumentId: 'a', provenance: proof }]);
  runtime = fixture.start(); // fresh coordinator and (Mongo) store instance
  assert.equal(await complete(runtime, start), 'deduplicated');
  await complete(runtime, order(source, 1, [['assign', { to: 'a', amount: 14 }], ['unlink'], ['delta', { amount: 10 }]]));
  const detached = await read(backend, source, 'a');
  assert.equal(reads, 1);
  assert.deepEqual(detached.row.targetDocumentIds, []);
  assert.equal(detached.row.seeds, undefined);
  assert.equal(detached.states[0]?.total, 30);
  assert.equal(detached.states[0]?.effects.at(-1), 'unlink:covered');
  const receipt = (await backend.history()).find((entry) => entry.commitId === start.commitId);
  const transition = receipt?.targets.find((target) => target.targetDocumentId === 'a')?.transitions[0];
  assert.equal(transition?.eventId, start.events[0].eventId);
  assert.deepEqual(transition?.joinSeeds, [proof]);
  assert.equal(transition?.changeType, 'create');
  await complete(runtime, order(source, 2, [['assign', { to: 'a', amount: 5 }], ['delta', { amount: 6 }]]));
  assert.equal((await read(backend, source, 'a')).states[0]?.total, 41);
  await complete(runtime, root('cross-source', true));
  assert.deepEqual((await read(backend, source, 'cross-source')).states, [{ total: 30, effects: ['attach', 'view:differentSource'] }]);
  assert.equal(reads, 3);
}

export async function unknown(backend: Backend, persisted?: Parameters<typeof snapshotFixture>[0]) {
  let reads = 0;
  const rt = fixtureRuntime(backend, snapshotFixture(async (id, signal) => {
    reads += 1;
    return persisted ? persisted(id, signal)
      : { state: { warehouse: { remaining: [75] } }, provenance: evidence(id, 'snapshot', { kind: 'unknown' }) };
  }));
  const streamId = randomUUID();
  await complete(rt.start(), order(streamId, 0, [['assign', { to: 'a', amount: 100 }], ['delta', { amount: 2 }]]));
  const { row, states } = await read(backend, streamId, 'a');
  assert.equal(reads, 1);
  assert.deepEqual(row.seeds?.[0]?.provenance.position, { kind: 'unknown' });
  assert.deepEqual(states[0], { total: 77, effects: ['assign:unseeded', 'snapshot:unknown', 'after:75', 'delta:unknown'] });
}

export async function failures(backend: Backend) {
  const streamId = randomUUID();
  const c = order(streamId, 0, [['assign', { to: 'a', amount: 10 }]]);
  const expected = evidence(orderId, 'projection', { kind: 'throughCommit', streamId, commitSequence: 0 });
  const known = { state: { booking: { total: 50 } }, provenance: expected };
  const cases: readonly [Parameters<typeof viewFixture>[0], string][] = [
    [async () => null, 'retryable'],
    [async () => { throw new Error('network unavailable'); }, 'retryable'],
    [async () => ({ ...known, provenance: evidence(orderId, 'projection', { kind: 'unknown' }) }), 'retryable'],
    [async () => ({ ...known, provenance: { ...expected, seedGeneration: 'wrong' } }), 'terminal'],
    [async () => ({ ...known, provenance: evidence('other-order', 'projection', expected.position) }), 'terminal'],
    [async () => ({ ...known, provenance: evidence(orderId, 'projection', { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) }), 'terminal'],
    [async () => ({ ...known, state: { ...known.state, foreignReference: { $ref: 'customers', $id: 'c-1' } } }), 'terminal']
  ];
  for (const [provider, expectedStatus] of cases) {
    const rt = fixtureRuntime(backend, viewFixture(provider));
    const result = await rt.start().process(c);
    assert.equal(result.status, expectedStatus, JSON.stringify(result));
    assert.equal(rt.coverage.has(streamId), false);
    const { row, progress, states } = await read(backend, streamId, 'a');
    assert.equal(row.revision, null);
    assert.equal(progress, null);
    assert.deepEqual(states, [null]);
    assert.equal((await backend.history()).length, 0);
  }
  const fixture = viewFixture(async () => known);
  const rt = fixtureRuntime(backend, fixture);
  assert.throws(() => createProjectionCommitCoordinator({ ...rt.options, store: backend.store(),
    definitions: [{ ...rt.options.definitions[0]!, joinSeedReaders: [] }] }), /exactly one reader/);
  const distinct = viewFixture(async () => known).reader;
  assert.throws(() => createProjectionCommitCoordinator({ ...rt.options, store: backend.store(),
    definitions: [{ ...rt.options.definitions[0]!, joinSeedReaders: [distinct, fixture.reader] }] }), /exactly one reader/);
  const wrongReader = snapshotFixture(async () => null).reader;
  assert.throws(() => createProjectionCommitCoordinator({ ...rt.options, store: backend.store(),
    definitions: [{ ...rt.options.definitions[0]!, joinSeedReaders: [wrongReader] }] }), /immutable manifest/);
  const mismatch = fixtureRuntime(backend, viewFixture(async () => {
    assert.fail('Unregistered token must not reach the reader.');
  }, true));
  const invalid = await mismatch.start().process(c);
  assert.equal(invalid.status, 'terminal');
  assert.match('reason' in invalid ? invalid.reason : '', /registered binding/);
  assert.equal((await read(backend, streamId, 'a')).progress, null);
  const throwing = fixtureRuntime(backend, { ...fixture, definition: { ...fixture.definition,
    joinInitializers: fixture.definition.joinInitializers!.map((item) => ({ ...item, initialize(draft) {
      draft.total = 999;
      throw new Error('Initializer threw after mutation.');
    } })) } });
  assert.equal((await throwing.start().process(c)).status, 'terminal');
  const afterThrow = await read(backend, streamId, 'a');
  assert.deepEqual(afterThrow.states, [null]);
  assert.equal(afterThrow.row.revision, null);
  assert.equal(afterThrow.progress, null);
  await complete(rt.start(), c);
  assert.equal((await read(backend, streamId, 'a')).states[0]?.total, 50);
}

export async function sourceOnlyMetadata(backend: Backend) {
  const foreignReference = { $ref: 'customers', $id: 'c-1' };
  const metadata = { foreignReference };
  const streamId = randomUUID();
  const base = order(streamId, 0, [['assign', { to: 'a', amount: 2 }]]);
  const commit = { ...base, events: [{ ...base.events[0], metadata }] as const };
  assert(validateProjectionSourceCommit(commit).valid);
  const fixture = viewFixture(async (id) => ({ state: { booking: { total: 44 } },
    provenance: evidence(id, 'projection', { kind: 'throughCommit', streamId, commitSequence: 0 }) }));
  const initialized = fixtureRuntime(backend, { ...fixture, definition: { ...fixture.definition,
    joinInitializers: fixture.definition.joinInitializers!.map((registration) => ({ ...registration, initialize(draft, seed, info) {
      const detached = info.event.metadata;
      assert(detached && Object.isFrozen(info.event) && Object.isFrozen(detached));
      assert.notEqual(detached, metadata);
      const ref = detached.foreignReference;
      assert(ref && typeof ref === 'object' && Object.isFrozen(ref));
      assert.notEqual(ref, foreignReference);
      assert.equal(Reflect.set(ref, '$id', 'changed'), false);
      assert.deepEqual(ref, foreignReference);
      return registration.initialize(draft, seed, info);
    } })) } });
  await complete(initialized.start(), commit);
  const { row, states, progress } = await read(backend, streamId, 'a');
  assert.equal(foreignReference.$id, 'c-1');
  assert.equal(states[0]?.total, 44);
  assert.equal(progress, 0);
  assert.equal(row.seeds?.length, 1);
  assert(!JSON.stringify(await backend.history()).includes('foreignReference'));
}

export async function crossSourceMismatch(backend: Backend) {
  const reported = randomUUID();
  const actual = randomUUID();
  const rt = fixtureRuntime(backend, viewFixture(async (id) => ({ state: { booking: { total: 44 } },
    provenance: evidence(id, 'projection', { kind: 'throughCommit', streamId: reported, commitSequence: 0 }) })));
  const worker = rt.start();
  await complete(worker, root('a', true));
  const before = await read(backend, actual, 'a');
  const result = await worker.process(order(actual, 0, [['unlink']]));
  assert.equal(result.status, 'terminal');
  assert.match('reason' in result ? result.reason : '', /triggering aggregate stream/);
  assert.equal(rt.coverage.has(actual), false);
  assert.deepEqual(await read(backend, actual, 'a'), before);
}

export async function providerRace(backend: Backend) {
  const streamId = randomUUID();
  let entered!: () => void;
  const inProvider = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void;
  const release = new Promise<void>((resolve) => { resume = resolve; });
  const fixture = fixtureRuntime(backend, viewFixture(async () => {
    entered();
    await release;
    return { state: { booking: { total: 30 } }, provenance: evidence(orderId, 'projection',
      { kind: 'throughCommit', streamId, commitSequence: 0 }) };
  }));
  const runtime = fixture.start();
  const main = complete(runtime, order(streamId, 0, [['assign', { to: 'a', amount: 10 }]]));
  await inProvider;
  try {
    await complete(runtime, root('a', false)); // same target lane, different source
  } finally { resume(); }
  await main;
  const { states, row } = await read(backend, streamId, 'a');
  assert.deepEqual(states[0], { total: 0, effects: ['attach', 'assign:unseeded', 'after:0'] });
  assert.equal(row.seeds, undefined);
}

export async function conflict(backend: Backend, fallback: boolean) {
  const streamId = randomUUID();
  const underlying = backend.store();
  let commits = 0;
  let reads = 0;
  const store: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: underlying.joinMembershipCapability, joinSeedCapability: underlying.joinSeedCapability,
    projectionChangesCapability: underlying.projectionChangesCapability,
    sourceCommitSnapshotCapability: fallback ? undefined : underlying.sourceCommitSnapshotCapability,
    loadProjectionSourceCommitSnapshot: (req) => underlying.loadProjectionSourceCommitSnapshot(req),
    async commitProjectionSourceCommit(req, snapshot) {
      if (++commits === 1) return { version: 1, status: 'rejected', category: 'conflict', retryable: true, reason: 'fixture conflict' };
      return underlying.commitProjectionSourceCommit(req, snapshot);
    }
  };
  const fixture = fixtureRuntime(backend, viewFixture(async () => {
    reads += 1;
    return { state: { booking: { total: reads } }, provenance: evidence(orderId, 'projection',
      { kind: 'throughCommit', streamId, commitSequence: 0 }) };
  }));
  await complete(fixture.start(store), order(streamId, 0, [['assign', { to: 'a', amount: 3 }]]));
  assert.equal(reads, 1);
  assert.equal(commits, 2);
  const { states, row, progress } = await read(backend, streamId, 'a');
  assert.deepEqual(states[0], { total: 1, effects: ['assign:unseeded', 'view:covered', 'after:1'] });
  assert.equal(row.revision, 1);
  assert.equal(progress, 0);
  assert.equal((await backend.history()).length, 1);
}
