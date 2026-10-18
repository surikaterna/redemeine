import { createAggregate, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event, RedemeinePlugin } from '@redemeine/kernel';
import { createMirage, dispatch, extractState, extractUncommittedEvents } from '../src';
import { createDepot, type EventStore } from '../src/Depot';

function definition(calls: string[] = [], initialize = () => ({ seen: [] as number[], all: 0 })) {
  const source = createAggregate('counter', { count: 0 })
    .events({ added(state, event: Event<number>) { calls.push('domain'); state.count += event.payload; } })
    .commands(emit => ({ add: (_state, amount: number) => emit.added(amount) })).build();
  const audit = createAggregatePluginFor(source, 'audit').state(initialize)
    .events({ added(draft, event, context) {
      calls.push(`matched:${context.state.count}`);
      draft.seen.push(event.payload);
    } }).onEvent(draft => { calls.push('all'); draft.all++; }).build();
  return { source, audit, built: source.withPlugins(audit) };
}

test('Mirage shortcuts and raw dispatch apply once, keeping lifecycle order and state isolation', async () => {
  const calls: string[] = [];
  const { built } = definition(calls);
  const legacy: RedemeinePlugin = { key: 'legacy', onBeforeCommand() { calls.push('before'); } };
  const live = createMirage(built.withPlugins(legacy), 'one');
  const other = createMirage(built, 'two');
  await live.add(2);
  await dispatch(live, built.commandCreators.add(3));
  expect(calls).toEqual(['before', 'domain', 'matched:2', 'all', 'before', 'domain', 'matched:5', 'all']);
  expect(live.audit.seen).toEqual([2, 3]);
  expect(live.audit.all).toBe(2);
  expect(other.audit.all).toBe(0);
  expect(built.initialState.audit.seen).toEqual([]);
  expect(extractUncommittedEvents(live)).toHaveLength(2);
  expect(() => Reflect.set(live.audit, 'all', 100)).toThrow();
});

test('Depot replay, append acknowledgement and snapshot tails do not double-apply plugins', async () => {
  const calls: string[] = [];
  const { built } = definition(calls);
  const stream: Event[] = [{ type: 'counter.added.event', payload: 2 }];
  const legacy: RedemeinePlugin = {
    key: 'legacy', onHydrateEvent() { calls.push('hydrate'); },
    onBeforeAppend() { calls.push('append'); }, onAfterCommit() { calls.push('commit'); }
  };
  const store: EventStore = {
    async *readStream(_id, options) { yield* stream.slice((options?.fromVersion ?? 1) - 1); },
    async saveEvents(_id, events, version) {
      expect(version).toBe(stream.length); calls.push('saved'); stream.push(...events);
    }
  };
  const depot = createDepot(built, store, { plugins: [legacy] });
  const live = await depot.get('one');
  expect(calls).toEqual(['hydrate', 'domain', 'matched:2', 'all']);
  expect(extractUncommittedEvents(live)).toEqual([]);
  const snapshot = { state: { count: live.count, audit: { seen: [...live.audit.seen], all: live.audit.all } }, version: 1 };
  calls.length = 0;
  await live.add(3);
  await depot.save(live);
  expect(calls).toEqual(['domain', 'matched:5', 'all', 'append', 'saved', 'commit']);
  expect(live.audit).toEqual({ seen: [2, 3], all: 2 });
  const tail = await depot.get('one', { snapshot });
  const full = await depot.get('one');
  expect(extractState(tail)).toEqual(extractState(full));
  expect(snapshot.state.audit).toEqual({ seen: [2], all: 1 });
  expect(built.initialState.audit.all).toBe(0);
});

test('host setup rejects misplaced event descriptors before replay, even with a lifecycle key', () => {
  const { source, audit } = definition();
  const misplaced = { ...audit, key: 'looks-like-lifecycle' };
  expect(() => Reflect.apply(createMirage, undefined, [source, 'bad', { plugins: [misplaced], events: [] }]))
    .toThrow('built.withPlugins');
  const store: EventStore = { async *readStream() {}, async saveEvents() {} };
  expect(() => Reflect.apply(createDepot, undefined, [source, store, { plugins: [misplaced] }]))
    .toThrow('Aggregate.plugins');
});

test('snapshot ingress rejects missing namespaces immediately without initializers or domain mutations', async () => {
  const calls: string[] = [];
  const initialize = jest.fn(() => ({ seen: [] as number[], all: 0 }));
  const { built } = definition(calls, initialize);
  initialize.mockClear();
  const snapshot = { count: 2 } as typeof built.initialState;
  expect(() => createMirage(built, 'missing', { snapshot })).toThrow('Missing aggregate plugin namespace: audit');
  await expect(createMirage(built, 'empty', { snapshot, events: [] })).rejects.toThrow('migrate');
  await expect(createMirage(built, 'tail', {
    snapshot, events: [{ type: 'counter.added.event', payload: 3 }]
  })).rejects.toThrow('migrate');
  expect(calls).toEqual([]);
  expect(initialize).not.toHaveBeenCalled();
});

test('Depot rejects obsolete snapshots and initial state before hydrate/save hooks even with empty tails', async () => {
  const calls: string[] = [];
  const { built } = definition(calls);
  const saveEvents = jest.fn(async () => {});
  const legacy: RedemeinePlugin = {
    key: 'legacy', onHydrateEvent() { calls.push('hydrate'); },
    onBeforeAppend() { calls.push('append'); }, onAfterCommit() { calls.push('commit'); }
  };
  const store: EventStore = { async *readStream() {}, saveEvents };
  const depot = createDepot(built, store, { plugins: [legacy] });
  const state = { count: 2 } as typeof built.initialState;
  await expect(depot.get('old', { snapshot: { state, version: 2 } })).rejects.toThrow('migrate');
  await expect(depot.get('old', { initialState: state })).rejects.toThrow('migrate');
  expect(saveEvents).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test('valid snapshot-only and empty-tail hosts preserve supplied plugin state; non-plugin snapshots are unchanged', async () => {
  const { source, built } = definition();
  const snapshot = { count: 2, audit: { seen: [2], all: 1 } };
  expect(extractState(createMirage(built, 'snapshot', { snapshot }))).toEqual(snapshot);
  expect(extractState(await createMirage(built, 'empty', { snapshot, events: [] }))).toEqual(snapshot);
  const store: EventStore = { async *readStream() {}, async saveEvents() {} };
  const loaded = await createDepot(built, store).get('valid', { snapshot: { state: snapshot, version: 1 } });
  expect(extractState(loaded)).toEqual(snapshot);
  expect(extractState(createMirage(source, 'plain', { snapshot: { count: 5 } }))).toEqual({ count: 5 });
  const { validateState: _unused, ...handwritten } = source;
  expect(extractState(createMirage(handwritten, 'handwritten', { snapshot: { count: 6 } }))).toEqual({ count: 6 });
});
