import { describe, expect, jest, test } from '@jest/globals';
import { createProjection } from '@redemeine/projection';
import { createProjection as coreProjection, selectJoinTargets, type ProjectionEvent } from '@redemeine/projection-runtime-core';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { coordinator, definition, fixtureOptions, orderId, snapshot, type State, turn } from '../../projection-transport/integration/joinMembershipFixture';

const source = '00000000-0000-4000-8000-000000000010';
const root = { aggregateType: 'Board', initialState: {}, pure: { eventProjectors: {} } };
const order = { aggregateType: 'Order', types: { events: { add: 'wire.added' as const } }, pure: { eventProjectors: {
  add: (_state: unknown, _event: { payload: { target: string } }) => {}
} } };
const event: ProjectionEvent = { aggregateType: 'Order', aggregateId: orderId, type: 'wire.added',
  sequence: 0, timestamp: '2026-11-19T00:00:00.000Z', payload: { target: 'B' } };

describe.each(['public', 'core'] as const)('%s builder', (builder) => {
  test('normalizes aliases, copies selectors and works through registered native execution', async () => {
    const options = fixtureOptions(new InMemoryProjectionStore<State>());
    const selectors = { add: (e: { payload: { target: string } }) => e.payload.target };
    const make = builder === 'public' ? createProjection<State> : coreProjection<State>;
    const projection = make('boards', (id) => ({ id, visits: [] })).deduplication({ strategy: 'own_record' })
      .from(root, {}).joinRight(order, selectors)
      .join(order, { add(draft, e, ctx) {
        if (e.payload.target !== draft.id) return;
        ctx.subscribeTo(order, e.aggregateId);
      } }).build();
    selectors.add = () => 'changed';
    expect(Object.isFrozen(projection.joinStreams?.[0]?.candidateSelectors)).toBe(true);
    const runtime = coordinator({ ...options, definitions: [{ ...options.definitions[0]!, definition: projection }] });
    expect(await runtime.process(turn(source, 0, orderId, [['wire.added', { target: 'B' }]]))).toMatchObject({ status: 'completed' });
    const current = await snapshot(options.store, source, ['B', 'changed']);
    expect(current.joinMemberships?.[0]?.targetDocumentIds).toEqual(['B']);
    expect(current.targets.map(({ state }) => state)).toEqual([{ id: 'B', visits: [] }, null]);
  });

  test('refuses selectors without corresponding joined handlers', () => {
    const make = builder === 'public' ? createProjection<State> : coreProjection<State>;
    expect(() => make('boards', (id) => ({ id, visits: [] })).from(root, {})
      .joinRight(order, { add: () => 'A' }).join(order, {}).build()).toThrow(/matching handlers/);
  });
});

test('a legacy build is valid but untyped registration still requires explicit deduplication', () => {
  const options = fixtureOptions(new InMemoryProjectionStore<State>());
  const legacy = createProjection('boards', (id): State => ({ id, visits: [] })).from(root, {}).build();
  expect(legacy).not.toHaveProperty('deduplication');
  // @ts-expect-error Exercise the runtime guard through an untyped caller.
  expect(() => coordinator({ ...options, definitions: [{ ...options.definitions[0]!, definition: legacy }] }))
    .toThrow(/requires an explicit deduplication strategy/);
});

test('shared routing validates candidate values and isolates the handler event', () => {
  expect(selectJoinTargets(event, ['A', 'B'], (copy) => {
    copy.payload.target = 'C';
    return ['B', 'C', 'B'];
  })).toEqual(['A', 'B', 'C']);
  expect(event.payload.target).toBe('B');
  // @ts-expect-error Exercise the runtime guard for untyped consumers.
  expect(() => selectJoinTargets(event, [], async () => 'B')).toThrow(/synchronous/);
  expect(() => selectJoinTargets(event, [], () => ['', 'B'])).toThrow(/candidate ID/);
  expect(() => selectJoinTargets(event, [], () => 'x'.repeat(1024 * 1024))).toThrow(/bytes/);
});

test('set generations refuse manifest mismatch, unsupported stores, and in_document', () => {
  const store = new InMemoryProjectionStore<State>();
  const options = fixtureOptions(store);
  expect(() => coordinator({ ...options, definitions: [{ ...options.definitions[0]!,
    definition: { ...definition(), joinMembership: undefined } }] })).toThrow(/immutable manifest/);
  expect(() => coordinator({ ...options, store: {
    loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    commitProjectionSourceCommit: store.commitProjectionSourceCommit.bind(store)
  } })).toThrow(/capable store/);
  expect(() => coordinator(fixtureOptions(store, [], { strategy: 'in_document' }))).toThrow(/own_record or none/);
});

test('event candidates are computed once across OCC retry and not recomputed on replay', async () => {
  const store = new InMemoryProjectionStore<State>();
  const select = jest.fn((e: { payload: { target: string } }) => e.payload.target);
  const projection = createProjection('boards', (id): State => ({ id, visits: [] })).from(root, {})
    .join(order, { add(draft) { draft.visits.push('applied'); } }).joinRight(order, { add: select })
    .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
  const options = fixtureOptions(store);
  const commit = store.commitProjectionSourceCommit.bind(store);
  jest.spyOn(store, 'commitProjectionSourceCommit').mockImplementationOnce(async () => ({
    version: 1, status: 'rejected', category: 'conflict', retryable: true, reason: 'synthetic conflict'
  })).mockImplementation(commit);
  const runtime = coordinator({ ...options, definitions: [{ ...options.definitions[0]!, definition: projection }] });
  const input = turn(source, 0, orderId, [['wire.added', { target: 'A' }], ['wire.added', { target: 'B' }]]);
  expect(await runtime.process(input)).toMatchObject({ status: 'completed', definitions: [{ outcome: { attempts: 2 } }] });
  expect(await runtime.process(input)).toMatchObject({ status: 'completed', definitions: [{ outcome: { status: 'deduplicated' } }] });
  expect(select).toHaveBeenCalledTimes(2);
  expect((await snapshot(store, source, ['A', 'B'])).targets.map((doc) => doc.state?.visits)).toEqual([['applied'], ['applied']]);
});

test('over-budget routing fails before loading any view keys', async () => {
  const store = new InMemoryProjectionStore<State>();
  const ids = Array.from({ length: 1024 }, (_, i) => `candidate-${i}`);
  const projection = createProjection('boards', (id): State => ({ id, visits: [] })).from(root, {})
    .join(order, { add() {} }).joinRight(order, { add: () => ids })
    .deduplication({ strategy: 'own_record' }).buildCommitDefinition();
  const options = fixtureOptions(store);
  const loads = jest.spyOn(store, 'loadProjectionSourceCommitSnapshot');
  const runtime = coordinator({ ...options, definitions: [{ ...options.definitions[0]!, definition: projection }] });
  const result = await runtime.process(turn(source, 0, orderId, Array.from({ length: 17 }, () => ['wire.added'])));
  expect(result).toMatchObject({ status: 'terminal', reason: 'Joined turn routing exceeds capacity.' });
  expect(loads.mock.calls.every(([request]) => request.targetDocumentIds.length === 0)).toBe(true);
});
