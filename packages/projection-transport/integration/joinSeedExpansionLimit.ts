import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { turn } from './joinMembershipFixture';
import { evidence, fixtureRuntime, generation, read, type Backend, type State, viewFixture } from './joinSeedFixture';
import { complete } from './joinSeedScenarios';

const group = (prefix: string) => Array.from({ length: 5 }, (_, index) => `${prefix}-${index}`);
const padding = 'x'.repeat(900_000);
const members = group('member').map((id) => id + padding);
type Limit = 'keys' | 'results';
type Routes = { old: readonly string[]; next: readonly string[] };
const keysFor = (limit: Limit): Routes => {
  const size = (key: string) => limit === 'keys' ? key + padding : key;
  return { old: group('old').map(size), next: group('new').map(size) };
};
const Order = { aggregateType: 'Order' };

function withExpansion(readOne: Parameters<typeof viewFixture>[0], genuine: boolean, routes: Routes) {
  const fixture = viewFixture(readOne);
  const from = fixture.definition.fromStream;
  const attach = from.handlers.attach!;
  return { ...fixture, definition: { ...fixture.definition, fromStream: { ...from, handlers: { ...from.handlers,
    attach(draft: Parameters<typeof attach>[0], event: Parameters<typeof attach>[1], ctx: Parameters<typeof attach>[2]) {
      const marker = Array.isArray(event.payload.ids) ? event.payload.ids[0] : undefined;
      if (marker !== 'pre' && marker !== 'post') return attach(draft, event, ctx);
      if (marker === 'pre') {
        const old = draft.total === 1;
        ctx.unsubscribeFrom(Order, 'first');
        draft.effects.push(old ? 'long' : 'short');
        for (const key of old ? routes.old : routes.next) ctx.unsubscribeFrom(Order, key);
      } else if (genuine && draft.effects.includes('short')) {
        for (const key of routes.old) ctx.unsubscribeFrom(Order, key);
      }
    }
  } } } };
}

function observedStore(store: ProjectionSourceCommitStorePort<State>, compatibility: boolean, limit: Limit, routes: Routes) {
  const counts = { resets: 0, receipts: 0, submissions: 0, committed: 0 };
  let seenOldKeys = false;
  const port: ProjectionSourceCommitStorePort<State> = {
    joinMembershipCapability: store.joinMembershipCapability, joinSeedCapability: store.joinSeedCapability,
    projectionChangesCapability: store.projectionChangesCapability,
    sourceCommitSnapshotCapability: compatibility ? undefined : store.sourceCommitSnapshotCapability,
    async loadProjectionSourceCommitSnapshot(request) {
      if (request.changeIdentity && request.progressStrategy === 'none') counts.receipts += 1;
      const hasOld = request.links.some(({ aggregateId }) => aggregateId === routes.old[0]);
      if (hasOld) seenOldKeys = true;
      if (seenOldKeys && request.progressStrategy === 'own_record' && !request.targetDocumentIds.length && !request.links.length) counts.resets += 1;
      // Neither the discarded read plan nor its replacement may exceed the actual snapshot budget.
      if (limit === 'keys') assert(!hasOld || !request.links.some(({ aggregateId }) => aggregateId === routes.next[0]));
      return store.loadProjectionSourceCommitSnapshot(request);
    },
    async commitProjectionSourceCommit(request, snapshot) {
      counts.submissions += 1;
      const result = await store.commitProjectionSourceCommit(request, snapshot);
      if (result.status === 'committed') counts.committed += 1;
      return result;
    }
  };
  return { port, counts };
}

async function provisionMemberships(store: ProjectionSourceCommitStorePort<State>, routes: Routes) {
  for (const group of [routes.old, routes.next]) {
    const commit = turn(randomUUID(), 0, 'ignored', [['attach']], 'Board');
    const result = await store.commitProjectionSourceCommit({
      version: 1, mode: 'atomic-all', projectionName: 'boards', projectionGeneration: generation, commit,
      finalDocuments: [], stagedLinks: [], joinMembershipFences: group.map((aggregateId, index) =>
        ({ aggregateType: 'Order', aggregateId, expectedRevision: null, targetDocumentIds: [members[index]!] })),
      progress: { strategy: 'own_record', source: { sourceId: commit.streamId, expectedSequence: null, finalSequence: 0 } }
    });
    assert.equal(result.status, 'committed');
  }
}

export async function staleSeedExpansion(backend: Backend, compatibility: boolean, recording: boolean, genuine: boolean, limit: Limit) {
  const routes = keysFor(limit);
  const source = randomUUID();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let seedReads = 0;
  const fixture = withExpansion(async (id) => {
    seedReads += 1;
    enter();
    await wait;
    return { state: { booking: { total: 50 } }, provenance: evidence(id, 'projection',
      { kind: 'throughCommit', streamId: randomUUID(), commitSequence: 0 }) };
  }, genuine, routes);
  const runtime = fixtureRuntime(backend, fixture, recording);
  const store = backend.store();
  if (limit === 'results') await provisionMemberships(store, routes);
  const { port, counts } = observedStore(store, compatibility, limit, routes);
  const setup = runtime.start();
  const board = (total: number) => turn(randomUUID(), 0, 'A', [['attach', { ids: ['unrelated'], total }]], 'Board');
  await complete(setup, board(1));
  const commit = turn(source, 0, 'A', [
    ['attach', { ids: ['pre'] }], ['attach', { ids: ['first'], seed: true }], ['attach', { ids: ['post'] }]
  ], 'Board');
  const pending = runtime.start(port).process(commit);
  await Promise.race([entered, pending.then((outcome) => assert.fail(`Seed did not start: ${JSON.stringify(outcome)}`))]);
  try { await complete(setup, board(2)); } finally { release(); }
  const result = await pending;
  const actual = await read(backend, source, 'A');
  assert.equal(seedReads, 1);
  assert.equal(counts.resets, Number(!genuine || recording || limit === 'results'));
  assert.equal(counts.committed, genuine ? 0 : 1);
  assert.equal(counts.submissions, Number(!genuine) + Number(!compatibility));
  assert.equal(counts.receipts, recording ? (genuine ? 2 : 1) : 0);
  assert.equal(result.status, genuine ? 'terminal' : 'completed', JSON.stringify(result));
  if (result.status === 'terminal') assert.match(result.reason, /routing exceeds capacity/);
  assert.equal(actual.progress, genuine ? null : 0);
  assert.equal(actual.states[0]?.total, genuine ? 2 : 50);
  assert.equal(runtime.coverage.get(source), genuine ? undefined : 0);
  const rows = await backend.store().loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: generation, targetDocumentIds: [],
    joinMembership: 'set-v1', joinSeedVersion: 1, progressStrategy: 'none',
    links: ['first', routes.old[0]!, routes.next[0]!].map((aggregateId) => ({ aggregateType: 'Order', aggregateId }))
  });
  const baseline = limit === 'results' ? 1 : null;
  assert.deepEqual(rows.joinMemberships?.map((row) => row.revision), genuine ? [null, baseline, baseline] : [1, baseline, (baseline ?? 0) + 1]);
  assert.equal((await backend.history()).filter(({ commitId }) => commitId === commit.commitId).length, recording && !genuine ? 1 : 0);
  console.log(JSON.stringify({ scenario: 'stale-seed-expansion', limit, compatibility, recording, genuine, seedReads, ...counts, status: result.status }));
}
