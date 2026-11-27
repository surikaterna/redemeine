import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjection, JoinTurnBudget, joinMembershipKey, type ProjectionContext,
  type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { coordinator, fixtureCoverage, fixtureOptions, snapshot, strategy, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

type Store = ProjectionSourceCommitStorePort<State>;
type Scenario = 'fresh' | 'stale-to-fit' | 'genuine-limit' | 'winner';
type Limit = 'keys' | 'results';
const group = (prefix: string, long: boolean) => Array.from({ length: 5 }, (_, index) =>
  `${prefix}${index}${long ? 'x'.repeat(900_000) : ''}`);
const longKeys = { old: group('old', true), next: group('new', true) };
const shortKeys = { old: group('old', false), next: group('new', false) };
const staticKey = `static${'x'.repeat(4_500_000)}`;
const member = `member${'x'.repeat(900_000)}`;
const board = { aggregateType: 'Board', pure: { eventProjectors: {
  update(_draft: unknown, _event: { payload: { value: string } }) {},
  route() {}
} } };
const order = { aggregateType: 'Order', pure: { eventProjectors: { ordinary() {} } } };

function optionsFor(store: Store, recording: boolean, keys: typeof shortKeys, includeOld: boolean) {
  const options = fixtureOptions(store);
  const route = (draft: State, _event: unknown, ctx: ProjectionContext) => {
    const routed = draft.visits[0] === 'old' ? keys.old : includeOld ? [...keys.next, ...keys.old] : keys.next;
    for (const key of routed) ctx.unsubscribeFrom(order, key);
    draft.visits.push('done');
  };
  const definition = createProjection('boards', (id): State => ({ id, visits: [] })).from(board, {
    update(draft, event) { draft.visits = [event.payload.value]; },
    route
  }).join(order, { ordinary: route }).joinRight(order, { ordinary: () => 'A' }).deduplication(strategy).build();
  return { ...options, definitions: [{ definition, generation: 'set-generation', ...(recording ? { projectionChanges: 'join-changes' } : {}) }],
    manifest: { ...options.manifest, definitions: options.manifest.definitions.map(({ projectionChanges, ...entry }) =>
      recording && projectionChanges !== undefined ? { ...entry, projectionChanges } : entry) } };
}

function observeStore(store: Store, compatibility: boolean, source: string, oldKey: string, afterOldRead: () => Promise<void>,
  afterConflict: () => Promise<void>) {
  const counts = { resets: 0, receipts: 0, writes: 0, conflicts: 0, attemptsWithOldKeys: 0 };
  let seenInitial = false;
  const port: Store = {
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    ...(compatibility ? {} : { sourceCommitSnapshotCapability: store.sourceCommitSnapshotCapability }),
    async loadProjectionSourceCommitSnapshot(request) {
      if (request.changeIdentity && request.progressStrategy === 'none') ++counts.receipts;
      const old = request.links.some(({ aggregateId }) => aggregateId === oldKey);
      const budget = new JoinTurnBudget();
      for (const { aggregateType, aggregateId } of request.links) budget.add(joinMembershipKey(aggregateType, aggregateId));
      if (request.sourceId === source && !request.targetDocumentIds.length) {
        if (seenInitial) ++counts.resets;
        seenInitial = true;
      }
      if (old) ++counts.attemptsWithOldKeys;
      const loaded = await store.loadProjectionSourceCommitSnapshot(request);
      if (old && counts.attemptsWithOldKeys === 1) await afterOldRead();
      else if (old && counts.attemptsWithOldKeys === 2 && counts.conflicts === 1) await afterConflict();
      return loaded;
    },
    async commitProjectionSourceCommit(request, observed) {
      ++counts.writes;
      const result = await store.commitProjectionSourceCommit(request, observed);
      if (result.status === 'rejected' && result.category === 'conflict') ++counts.conflicts;
      return result;
    }
  };
  return { port, counts };
}

async function provisionMembers(store: Store, keys: readonly string[]) {
  const commit = turn(randomUUID(), 0, 'A', [['route']], 'Board');
  const result = await store.commitProjectionSourceCommit({ version: 1, mode: 'atomic-all', projectionName: 'boards',
    projectionGeneration: 'set-generation', commit, finalDocuments: [], stagedLinks: [],
    progress: { strategy: 'own_record', source: { sourceId: commit.streamId, expectedSequence: null, finalSequence: 0 } },
    joinMembershipFences: keys.map((aggregateId) => ({ aggregateType: 'Order', aggregateId, expectedRevision: null, targetDocumentIds: [member] })) });
  assert.equal(result.status, 'committed');
}

async function runExpansionCapacity(store: Store, compatibility: boolean, recording: boolean, scenario: Scenario, backend: string, limit: Limit) {
  const source = randomUUID();
  const fresh = scenario === 'fresh';
  const genuine = scenario === 'genuine-limit';
  const winner = scenario === 'winner';
  const keys = limit === 'keys' ? longKeys : shortKeys;
  const resultLimit = limit === 'results';
  const input = genuine && !resultLimit ? turn(source, 0, staticKey, [['ordinary']]) : turn(source, 0, 'A', [['route']], 'Board');
  if (resultLimit) for (const group of [keys.old, keys.next]) await provisionMembers(store, group);
  const writerOptions = optionsFor(store, recording, keys, genuine && resultLimit);
  const writer = coordinator(writerOptions);
  const update = (value: string) => completed(writer, turn(randomUUID(), 0, 'A', [['update', { value }]], 'Board'));
  await update(fresh || genuine ? 'new' : 'old');
  const { port, counts } = observeStore(store, compatibility, source, keys.old[0]!, async () => {
    if (!fresh && !genuine) await update('new');
  }, async () => {
    if (winner) await completed(writer, input);
  });
  const options = optionsFor(port, recording, keys, genuine && resultLimit);
  const result = await coordinator(options).process(input);
  assert.equal(result.status, genuine ? 'terminal' : 'completed', JSON.stringify(result));
  if (result.status === 'terminal') assert.match(result.reason, /routing exceeds capacity/);
  assert.equal(result.definitions[0]?.outcome.status, genuine ? 'terminal' : winner ? 'deduplicated' : 'committed');
  assert.equal(await fixtureCoverage(options, input), genuine ? null : 0);
  const probes = !recording || fresh || (winner && resultLimit && backend === 'memory') ? 0 : genuine ? 2 : 1;
  assert.deepEqual(counts, { resets: fresh || winner ? 0 : 1, receipts: probes,
    writes: genuine ? 0 : fresh || winner ? 1 : 2, conflicts: fresh || genuine ? 0 : 1,
    attemptsWithOldKeys: genuine ? resultLimit ? 2 : 0 : fresh ? 0 : resultLimit ? 3 : 2 });
  const observed = await snapshot(store, source, ['A'], []);
  assert.deepEqual(observed.targets[0]?.state?.visits, genuine ? ['new'] : ['new', 'done']);
  assert.equal(observed.ownRecordSequence, genuine ? null : 0);
  for (const group of [keys.old, keys.next]) {
    const rows = await snapshot(store, source, [], group.map((aggregateId) => ({ aggregateType: 'Order', aggregateId })));
    const written = group === keys.next && !genuine;
    assert(rows.joinMemberships?.every(({ revision, targetDocumentIds }) =>
      revision === (resultLimit ? written ? 2 : 1 : written ? 1 : null)
      && targetDocumentIds.length === (resultLimit ? 1 : 0) && (!resultLimit || targetDocumentIds[0] === member)));
  }
  if (genuine && !resultLimit) assert.equal((await snapshot(store, source, [], [{ aggregateType: 'Order', aggregateId: staticKey }]))
    .joinMemberships?.[0]?.revision, null);
  if (recording) {
    const proof = await store.loadProjectionSourceCommitSnapshot({ projectionName: 'boards', projectionGeneration: 'set-generation',
      targetDocumentIds: [], links: [], progressStrategy: 'none',
      changeIdentity: { sourceId: source, commitId: input.commitId, commitSequence: 0, collection: 'join-changes' } });
    assert.equal(proof.changeReceipt, genuine ? 'missing' : 'committed');
  }
  console.log(JSON.stringify({ scenario: `expansion-${scenario}`, backend, limit, compatibility, recording, ...counts, status: result.status }));
}

export async function runExpansionCapacityMatrix(makeStore: () => Store, backend: 'memory' | 'mongo') {
  for (const limit of ['keys', 'results'] as const) {
    for (const compatibility of [false, true]) {
      for (const recording of [false, true]) {
        for (const scenario of ['fresh', 'stale-to-fit', 'genuine-limit'] as const) {
          await runExpansionCapacity(makeStore(), compatibility, recording, scenario, backend, limit);
        }
      }
      await runExpansionCapacity(makeStore(), compatibility, true, 'winner', backend, limit);
    }
  }
}
