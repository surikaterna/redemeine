import { describe, expect, test } from '@jest/globals';
import type { LiveWorkBudget, ProjectionCompleteCommitRangeRequest, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { createLiveCommitCoordinator } from '../src/liveCommitCoordinator';
import { floor, liveCommit, liveDefinition, LiveCounterStore, MemoryLiveOrder } from './liveFixtures';

function fixture(first = 42, maxCommits = 2, definitions = [liveDefinition()], rangeAvailable = true,
  budget: Partial<LiveWorkBudget> = {}, now?: () => number) {
  const order = new MemoryLiveOrder();
  const position = floor(liveCommit(first));
  order.positions.set(position.sourceId, position);
  const store = new LiveCounterStore();
  const reads: ProjectionCompleteCommitRangeRequest[] = [];
  const coordinator = createLiveCommitCoordinator({ epoch: 'epoch', registryDigest: 'registry',
    definitions: definitions.map((definition) => ({ definition, generation: 'generation' })), store, sourceOrder: order,
    budget: { maxCommits, maxBytes: 10000, maxMilliseconds: 10000, maxEventsPerCommit: 20, ...budget }, now, rangeReader: {
      capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      async readCompleteRange(request) {
        reads.push(request);
        if (!rangeAvailable) return { status: 'incomplete', reason: 'history_unavailable', details: 'fixture',
          continuationAfterSequence: request.afterSequence };
        return { status: 'complete', commits: [{ commit: liveCommit(request.throughSequence), encodedByteLength: 500 }],
          encodedByteLength: 500, continuationAfterSequence: request.throughSequence, hasMore: false };
      }
    } });
  return { coordinator, store, order, position, reads,
    process: (commit: ProjectionSourceCommit) => coordinator.process(commit, position, () => {}) };
}

describe('live suffix coordinator', () => {
  test.each(['joinStreams', 'reverseSubscribeStreams'] as const)('rejects %s even with no declared subscriptions', (field) => {
    const definition = liveDefinition();
    definition[field] = [{ aggregate: { aggregateType: 'Other' }, handlers: definition.fromStream.handlers }];
    expect(() => fixture(42, 2, [definition])).toThrow('unsupported_live_routing');
  });

  test('permanent event-derived empty target repeats without own-record or inline marker', async () => {
    const definition = liveDefinition();
    definition.identity = () => [];
    const f = fixture(42, 2, [definition]);
    expect((await f.process(liveCommit(42))).status).toBe('completed');
    expect((await f.process(liveCommit(42))).status).toBe('completed');
    expect(f.store.targets.size).toBe(0);
    expect(f.store.own.size).toBe(0);
    expect(f.store.writes.every((request) => request.finalDocuments.length === 0
      && request.progress.strategy === 'in_document' && request.progress.targets.length === 0)).toBe(true);
  });

  test.each([{ target: ['one', 'two'] }, { target: 'x'.repeat(513) }])('rejects unqualified or oversized target identity before persistence', async ({ target }) => {
    const definition = liveDefinition();
    definition.identity = () => target;
    const f = fixture(42, 2, [definition]);
    expect((await f.process(liveCommit(42))).status).toBe('paused');
    expect(f.store.writes).toEqual([]);
  });

  test('registry snapshot is not rerouted by later caller mutation', async () => {
    const definition = liveDefinition();
    const f = fixture(42, 2, [definition]);
    definition.identity = () => 'wrong';
    definition.fromStream.handlers.Added = () => { throw new Error('mutated'); };
    definition.fromStream.aggregate.aggregateType = 'wrong';
    expect((await f.process(liveCommit(42))).status).toBe('completed');
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 1 });
  });

  test('malformed owned markers pause even on a new uncovered commit', async () => {
    const f = fixture();
    await f.process(liveCommit(42));
    const target = f.store.targets.get('counter:shared');
    if (!target) throw new Error('missing target');
    f.store.targets.set('counter:shared', { ...target, sourceProgress: {} });
    expect(await f.process(liveCommit(43))).toMatchObject({ status: 'paused', reason: 'marker_lifetime_violation', coveredThrough: 42 });
    expect(f.store.writes).toHaveLength(1);
  });

  test('byte and cooperative time budgets bound turns without accumulating result arrays', async () => {
    const oversized = fixture(42, 2, [liveDefinition()], true, { maxBytes: 1 });
    expect((await oversized.process(liveCommit(42))).reason).toBe('live_payload_capacity');
    expect(oversized.store.writes).toEqual([]);
    let time = 0;
    const timed = fixture(42, 100, [liveDefinition()], true, { maxMilliseconds: 3 }, () => time++);
    await timed.process(liveCommit(42));
    expect(await timed.process(liveCommit(45))).toEqual({ status: 'continuation', processedCommits: 1, coveredThrough: 43 });
    expect(timed.reads).toHaveLength(1);
    const bytes = fixture(42, 100, [liveDefinition()], true, { maxBytes: 650 });
    await bytes.process(liveCommit(42));
    expect(await bytes.process(liveCommit(45))).toEqual({ status: 'continuation', processedCommits: 1, coveredThrough: 43 });
    expect(bytes.reads.every((request) => request.maxCommits === 1 && request.maxBytes === 650)).toBe(true);
  });

  test('missing within-live history pauses without folding incoming or advancing coverage', async () => {
    const f = fixture(42, 2, [liveDefinition()], false);
    await f.process(liveCommit(42));
    expect(await f.process(liveCommit(44))).toMatchObject({ status: 'paused', reason: 'live_history_unavailable', coveredThrough: 42 });
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 1 });
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]?.afterSequence).toBe(42);
  });

  test('registry and floor collisions refuse before any write', async () => {
    const f = fixture();
    f.order.positions.set(f.position.sourceId, { ...f.position, registryDigest: 'changed' });
    expect((await f.process(liveCommit(42))).status).toBe('paused');
    f.order.positions.set(f.position.sourceId, { ...f.position, firstCommitId: liveCommit(43).commitId });
    expect((await f.process(liveCommit(42))).status).toBe('paused');
    expect(f.store.writes).toEqual([]);
    expect(() => fixture(42, 1, [liveDefinition('same'), liveDefinition('same')])).toThrow('collision');
  });

  test('no total-source materialization: large inactive inventory costs one point-load per turn', async () => {
    const f = fixture();
    for (let index = 0; index < 100000; index += 1) {
      f.order.positions.set(`inactive-${index}`, { ...f.position, sourceId: `inactive-${index}` });
    }
    for (let index = 0; index < 5; index += 1) await f.process(liveCommit(42));
    expect(f.order.loads).toBe(5);
    expect(f.reads).toEqual([]);
    expect(f.store.targets.size).toBe(1);
    expect(f.store.writes).toHaveLength(1);
  });

  test('event work capacity refuses an oversized turn before fold', async () => {
    const f = fixture();
    const commit = liveCommit(42);
    commit.events = [commit.events[0], ...Array.from({ length: 20 }, (_, index) => ({ ...commit.events[0],
      eventIndex: index + 1, streamVersion: index + 43 }))];
    expect((await f.process(commit)).status).toBe('paused');
    expect(f.store.writes).toEqual([]);
  });

  test.each([0, 42])('processes first %i without any historical range read', async (first) => {
    const f = fixture(first);
    expect(await f.process(liveCommit(first))).toEqual({ status: 'completed', processedCommits: 1, coveredThrough: first });
    expect(f.reads).toEqual([]);
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 1 });
    expect(f.store.own.size).toBe(0);
  });

  test('repairs only 43 between F42 and 44; duplicates still dispatch via markers', async () => {
    const f = fixture();
    await f.process(liveCommit(42));
    expect((await f.process(liveCommit(44))).status).toBe('completed');
    expect(f.reads.map((r) => [r.afterSequence, r.throughSequence])).toEqual([[42, 43]]);
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 3 });
    f.store.targets.delete('counter:shared');
    expect((await f.process(liveCommit(44))).status).toBe('paused');
    expect(f.store.targets.size).toBe(0);
  });

  test('all same-target events fold against the pre-commit marker', async () => {
    const f = fixture();
    const commit = liveCommit(42);
    commit.events = [commit.events[0], { ...commit.events[0], eventId: '00000000-0000-4000-8002-000000000002',
      eventIndex: 1, streamVersion: 43 }];
    await f.process(commit);
    await f.process(commit);
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 2 });
    expect(f.store.writes).toHaveLength(1);
  });

  test('partial A/B retry retains null coverage and never synthesizes own-record baseline', async () => {
    const f = fixture(42, 2, [liveDefinition('a'), liveDefinition('b', 'own_record')]);
    f.store.failDefinition = 'b';
    expect((await f.process(liveCommit(42))).status).toBe('paused');
    expect(f.order.positions.get(f.position.sourceId)?.coveredThrough).toBeNull();
    f.store.failDefinition = undefined;
    expect((await f.process(liveCommit(42))).status).toBe('completed');
    expect(f.store.targets.get('a:shared')?.state).toEqual({ count: 1 });
    const own = f.store.writes.find((r) => r.progress.strategy === 'own_record')?.progress;
    expect(own).toEqual({ strategy: 'own_record', source: { sourceId: f.position.sourceId, expectedSequence: null, finalSequence: 42 } });
  });

  test('continuations retain bounded counts, and never treat coverage as dedupe', async () => {
    const f = fixture(42, 1);
    await f.process(liveCommit(42));
    expect(await f.process(liveCommit(45))).toEqual({ status: 'continuation', processedCommits: 1, coveredThrough: 43 });
    expect(await f.process(liveCommit(45))).toEqual({ status: 'continuation', processedCommits: 1, coveredThrough: 44 });
    expect((await f.process(liveCommit(45))).status).toBe('completed');
    expect((await f.process(liveCommit(41))).status).toBe('paused');
    expect(f.reads.every((r) => r.afterSequence !== null && r.afterSequence >= 42)).toBe(true);
  });

  test('static commutative fan-in and permanent no-handler require no completion receipt', async () => {
    const f = fixture();
    await f.process(liveCommit(42));
    const other = liveCommit(10, '00000000-0000-4000-8000-000000000002');
    const otherFloor = floor(other);
    f.order.positions.set(other.streamId, otherFloor);
    await f.coordinator.process(other, otherFloor, () => {});
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 2 });
    expect(Object.keys(f.store.targets.get('counter:shared')?.sourceProgress ?? {})).toHaveLength(2);
    const unmatched = liveCommit(43);
    unmatched.events[0].type = 'Ignored';
    await f.process(unmatched);
    await f.process(unmatched);
    expect(f.store.targets.get('counter:shared')?.state).toEqual({ count: 2 });
    expect(f.store.own.size).toBe(0);
  });

  test('handler link intents and invalid session refuse before persistence', async () => {
    const definition = liveDefinition();
    definition.fromStream.handlers.Added = (_state, _event, context) => context.subscribeTo({ aggregateType: 'Other' }, 'id');
    const f = fixture(42, 2, [definition]);
    expect((await f.process(liveCommit(42))).status).toBe('paused');
    expect(f.store.writes).toEqual([]);
    expect((await f.coordinator.process(liveCommit(42), f.position, () => { throw new Error('cancelled'); })).status).toBe('paused');
  });
});
