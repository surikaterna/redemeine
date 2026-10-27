import { produce } from 'immer';
import type { Event } from '@redemeine/kernel';
import { commandMetadata, createAggregate, createAggregatePluginFor, createEntity, createMixin } from '../src';

type Row = { code: string; qty: number };
const wire = 'store.rows.changed.event';
const payload = { code: 'a', qty: 3 };

test('compiled projectors retain unbound invocation semantics', () => {
  const projector = function(this: void, draft: { qty: number }) {
    expect(this).toBeUndefined();
    draft.qty++;
  };
  const row = createEntity<Row, 'row'>('row').events({ changed: projector }).build();
  const state = { qty: 99, rows: [{ code: 'a', qty: 1 }] };
  const host = createAggregate('store', state).events({ changed: projector }).entityList('rows', row, { pk: 'code' }).build();
  expect(host.apply(state, { type: 'store.changed.event', payload: {} }).qty).toBe(100);
  expect(host.apply(state, { type: wire, payload }).rows[0]!.qty).toBe(2);
  expect(Object.isFrozen(projector)).toBe(false);
});

function snapshotFixture(nested: boolean, flattened: boolean, decorated: boolean) {
  const pk = ['id', 'region'];
  const parentPk = ['id'];
  const rows = [{ id: 'a', code: 'b', region: 'x', qty: 1 }, { id: 'b', code: 'a', region: 'x', qty: 10 }];
  const parentState = { id: 'p', code: 'q', qty: 99, rows: structuredClone(rows) };
  const state = { qty: 99, rows, parents: [parentState, { ...structuredClone(parentState), id: 'q', code: 'p' }] };
  const row = createEntity<typeof rows[number], 'row'>('row').events({
    changed(draft, event: Event<{ qty: number }>) { draft.qty = event.payload.qty; }
  }).commands(emit => ({ set(selected, input: Record<string, unknown>) {
    return emit.changed({ ...input, qty: selected.qty + 2 });
  } })).build();
  const parent = createEntity<typeof parentState, 'parent'>('parent').entityList('rows', row, { pk }).build();
  const sourceBuilder = createMixin<typeof state>();
  const source = nested ? sourceBuilder.entityList('parents', parent, { pk: parentPk }).build()
    : sourceBuilder.entityList('rows', row, { pk }).build();
  const builder = createAggregate('store', state);
  const built = flattened ? builder.mixins({ ...source, mountedEntities: [] }).build()
    : nested ? builder.entityList('parents', parent, { pk: parentPk }).build() : builder.entityList('rows', row, { pk }).build();
  const host = decorated ? built.withPlugins() : built;
  const mounts = flattened ? source.mounts : host.mounts;
  const chain = Object.values(mounts[nested ? 'parents' : 'rows']!.eventTargets!)[0]!;
  const command = nested ? host.types.commands.parentsRowsSet : host.types.commands.rowsSet;
  const input = { parentsId: 'p', id: 'a', region: 'x', code: 'a' };
  const expected = structuredClone(state);
  (nested ? expected.parents[0]! : expected).rows[0]!.qty = 3;
  return { host, state, chain, pk, parentPk, command, input, expected };
}

describe.each([
  [false, false, false], [false, false, true], [false, true, false], [false, true, true],
  [true, false, false], [true, false, true], [true, true, false], [true, true, true]
])('decorated=%s nested=%s flattened=%s dispatch snapshots', (decorated, nested, flattened) => {
  test.each(['chain', 'statePath', 'step', 'callerPk'] as const)('%s mutations cannot redirect replay', mutation => {
    const fixture = snapshotFixture(nested, flattened, decorated);
    const { host, state, chain, pk, parentPk, command, input, expected } = fixture;
    const query = commandMetadata(host, nested ? 'parentsRowsSet' : 'rowsSet')!;
    expect(Reflect.set(query.targets, 'length', 0)).toBe(false);
    for (const step of query.targets) {
      expect(Reflect.set(step, 'kind', 'map')).toBe(false);
      expect(Reflect.set(step.statePath, '0', 'missing')).toBe(false);
      expect(Reflect.set(step.pk!, '0', 'wrong')).toBe(false);
    }
    if (mutation === 'chain') expect(Reflect.set(chain, 'length', 0)).toBe(true);
    if (mutation === 'statePath') for (const step of chain) expect(Reflect.set(step.statePath, '0', 'missing')).toBe(true);
    if (mutation === 'step') for (const step of chain) expect(Reflect.set(step, 'kind', 'map')).toBe(true);
    if (mutation === 'callerPk') {
      expect(Object.isFrozen(pk)).toBe(false);
      expect(Object.isFrozen(parentPk)).toBe(false);
      pk[0] = 'code'; parentPk[0] = 'code';
      expect(pk).toEqual(['code', 'region']);
    }
    const [event] = host.process(state, { type: command!, payload: input });
    expect(event!.payload).toEqual({ ...input, qty: 3 });
    expect(host.apply(state, event!)).toEqual(expected);
    const draft = structuredClone(state);
    host.applyToDraft(draft, event!);
    expect(draft).toEqual(expected);
    expect(() => host.apply(state, { type: event!.type, payload: {} })).toThrow('Invalid mounted command target');
    expect(() => host.applyToDraft(structuredClone(state), { type: event!.type, payload: {} })).toThrow('Invalid mounted command target');
  });
});

test('unknown targeted-looking wires use the default warning without invoking root or traversing', () => {
  const state = { qty: 99, rows: [{ id: 'a', qty: 1 }] };
  const projector = jest.fn();
  const host = createAggregate('store', state).events({ changed: projector }).build();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const type of ['store.rows.changed.event', 'store.missing.changed.event', '__proto__', 'constructor']) {
      const event = { type, payload: { id: 'a', qty: 3 } };
      expect(host.apply(state, event)).toEqual(state);
      const draft = structuredClone(state);
      host.applyToDraft(draft, event);
      expect(draft).toEqual(state);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining(type));
    }
    expect(projector).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(8);
  } finally {
    warn.mockRestore();
  }
});

test('known mounted wires reject invalid identity before projection, never trying root or unmatched', () => {
  const root = jest.fn();
  const scoped = jest.fn((draft: Row, event: Event<typeof payload>) => { draft.qty = event.payload.qty; });
  const row = createEntity<Row, 'row'>('row').events({ changed: scoped }).build();
  const unmatched = jest.fn();
  const state = { qty: 99, rows: [{ code: 'a', qty: 1 }] };
  const host = createAggregate('store', state).events({ changed: root }).overrideEventNames({ changed: wire })
    .entityList('rows', row, { pk: 'code' }).onUnmatchedEvent(unmatched).build();
  for (const invalid of [{}, { code: 'missing' }, { rowsCode: 'a' }]) {
    const event = { type: wire, payload: invalid };
    expect(() => host.apply(state, event)).toThrow('Invalid mounted command target');
    const draft = structuredClone(state);
    expect(() => host.applyToDraft(draft, event)).toThrow('Invalid mounted command target');
    expect(draft).toEqual(state);
  }
  expect(scoped).not.toHaveBeenCalled();
  expect(root).not.toHaveBeenCalled();
  expect(unmatched).not.toHaveBeenCalled();
  expect(host.apply(state, { type: wire, payload }).rows[0]!.qty).toBe(3);
});

test('flattened scoped provenance and overrides survive without mount replay and beat root wire collisions', () => {
  const row = createEntity<Row, 'row'>('row').events({ changed(draft, event: Event<typeof payload>) {
    draft.qty = event.payload.qty;
  } }).build();
  const state = { qty: 99, rows: [{ code: 'a', qty: 1 }] };
  const source = createMixin<typeof state>().entityList('rows', row, { pk: 'code' }, {
    eventNameOverrides: { changed: wire }
  }).build();
  const root = createMixin<typeof state>().events({ rootChanged(draft) { draft.qty++; } })
    .overrideEventNames({ rootChanged: wire }).build();
  const builder = createAggregate('store', state).mixins({ ...source, mountedEntities: [] }, root);
  for (const host of [builder.build(), builder.build()]) {
    const expected = { qty: 99, rows: [{ code: 'a', qty: 3 }] };
    expect(host.apply(state, { type: wire, payload })).toEqual(expected);
    expect(produce(state, draft => host.applyToDraft(draft, { type: wire, payload }))).toEqual(expected);
    expect(host.types.events.rowsChanged).toBe(wire);
  }
});

test('last actual repeated wire assignment replaces both projector and list/map target', () => {
  const first = createEntity<Row, 'first'>('first').events({ changed(draft) { draft.qty += 1; } }).build();
  const last = createEntity<Row, 'last'>('last').events({ changed(draft) { draft.qty += 10; } }).build();
  const state = { left: { a: { code: 'a', qty: 1 } }, right: [{ code: 'a', qty: 2 }] };
  const overrides = { eventNameOverrides: { changed: wire } };
  const host = createAggregate('store', state).entityList('left', first, { pk: 'code' }, overrides)
    .entityList('right', first, { pk: 'code' }, overrides).entityMap('left', last, {}, overrides).build();
  const expected = { ...state, left: { a: { code: 'a', qty: 11 } } };
  expect(host.apply(state, { type: wire, payload: { key: 'a' } })).toEqual(expected);
  const draft = structuredClone(state);
  host.applyToDraft(draft, { type: wire, payload: { key: 'a' } });
  expect(draft).toEqual(expected);
  expect(() => host.apply(state, { type: wire, payload: { code: 'a' } })).toThrow('Invalid mounted command target');
});

test.each(['flattened', 'nested'] as const)('%s scoped wire collisions use assignment order rather than first key insertion', kind => {
  const first = createEntity<Row, 'first'>('first').events({ changed(draft) { draft.qty += 1; } }).build();
  const last = createEntity<Row, 'last'>('last').events({ changed(draft) { draft.qty += 10; } }).build();
  const local = { id: 'p', left: [{ code: 'a', qty: 1 }], right: [{ code: 'a', qty: 2 }] };
  const overrides = { eventNameOverrides: { changed: 'shared.event' } };
  const source = createMixin<typeof local>().entityList('left', first, { pk: 'code' }, overrides)
    .entityList('right', first, { pk: 'code' }, overrides).entityList('left', last, { pk: 'code' }, overrides).build();
  const parent = createEntity<typeof local, 'parent'>('parent').entityList('left', first, { pk: 'code' }, overrides)
    .entityList('right', first, { pk: 'code' }, overrides).entityList('left', last, { pk: 'code' }, overrides).build();
  const state = { ...local, parents: [structuredClone(local)] };
  const base = createAggregate('store', state);
  const host = kind === 'flattened' ? base.mixins({ ...source, mountedEntities: [] }).build()
    : base.entityList('parents', parent).build();
  const event = { type: kind === 'flattened' ? 'shared.event' : 'store.parents.shared.event', payload: { parentsId: 'p', code: 'a' } };
  const expected = structuredClone(state);
  (kind === 'flattened' ? expected : expected.parents[0]!).left[0]!.qty = 11;
  expect(host.apply(state, event)).toEqual(expected);
  expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
});

test('dotted root dispatch precedes matched plugin handlers and replay preserves rollback on plugin failure', () => {
  const calls: string[] = [];
  const base = createAggregate('store', { qty: 1 }).events({ changed(draft, event: Event<{ fail?: boolean }>) {
    calls.push('root'); draft.qty++;
    if (event.payload.fail) throw new Error('root failed');
  } }).overrideEventNames({ changed: wire }).build();
  const plugin = createAggregatePluginFor(base, 'audit').state(() => ({ seen: 0 })).events({
    changed(draft, _event, context) { calls.push(`matched:${context.state.qty}`); draft.seen++; }
  }).onEvent(draft => { calls.push(`all:${draft.seen}`); }).build();
  const host = base.withPlugins(plugin);
  const event = { type: wire, payload: {} };
  const expected = { qty: 2, audit: { seen: 1 } };
  expect(host.apply(host.initialState, event)).toEqual(expected);
  expect(calls).toEqual(['root', 'matched:2', 'all:1']);
  calls.length = 0;
  expect(produce(host.initialState, draft => host.applyToDraft(draft, event))).toEqual(expected);
  expect(calls).toEqual(['root', 'matched:2', 'all:1']);
  expect(() => host.apply(host.initialState, { type: wire, payload: { fail: true } })).toThrow('root failed');
  expect(host.initialState).toEqual({ qty: 1, audit: { seen: 0 } });
  const failing = base.withPlugins(createAggregatePluginFor(base, 'bad').state(() => ({ seen: 0 }))
    .onEvent(draft => { draft.seen++; throw new Error('plugin failed'); }).build());
  expect(() => failing.apply(failing.initialState, event)).toThrow('plugin failed');
  expect(failing.initialState).toEqual({ qty: 1, bad: { seen: 0 } });
});
