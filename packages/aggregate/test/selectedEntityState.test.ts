import { createAggregate, createEntity, createMixin } from '../src';
import type { Event } from '@redemeine/kernel';
import { produce } from 'immer';

test('mounted setQuantity sees selected state, while registration sees the root', () => {
  const line = createEntity<{ id: string; qty: number }, 'line'>('line')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ setQuantity(state, payload: { id: string; qty: number }) {
      expect(state.qty).toBe(2);
      expect(() => Reflect.set(state, 'qty', 99)).toThrow();
      return emit.changed({ id: payload.id, qty: state.qty + payload.qty });
    } })).build();
  const host = createAggregate('order', { lines: [{ id: 'a', qty: 2 }] })
    .entityList('lines', line)
    .events({ registered(state, event: Event<{ id: string; qty: number }>) { state.lines.push(event.payload); } })
    .commands(emit => ({ register(state, payload: { id: string; qty: number }) {
      expect(state.lines).toHaveLength(0);
      return emit.registered(payload);
    } })).build();
  const events = host.process(host.initialState, host.commandCreators.linesSetQuantity({ id: 'a', qty: 3 }));
  expect(events[0]!.payload).toEqual({ id: 'a', qty: 5 });
  expect(host.apply(host.initialState, events[0]!).lines[0]!.qty).toBe(5);
  expect(host.process({ lines: [] }, host.commandCreators.register({ id: 'b', qty: 1 }))).toHaveLength(1);
});

test.each(['single', 'composite'] as const)('declared %s PK payload replays through apply and applyToDraft', kind => {
  const entity = createEntity<Row, 'row'>('row')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const host = createAggregate('store', { rows: [row('a', 4)] })
    .entityList('rows', entity, { pk: kind === 'single' ? 'code' : ['domain', 'authority'] as const }).build();
  const payload = kind === 'single' ? { code: 'a' } : { domain: 'a', authority: 'owner', key: 'not-an-identity' };
  const event = host.process(host.initialState, host.commandCreators.rowsSet(payload))[0]!;
  const applied = host.apply(host.initialState, event);
  const drafted = produce(host.initialState, draft => host.applyToDraft(draft, event));
  expect(applied.rows[0]!.qty).toBe(5);
  expect(drafted).toEqual(applied);
  expect(host.initialState.rows[0]!.qty).toBe(4);
});

test('selected command views protect nested objects and native values and retain command intents/context', () => {
  const value = { id: 'a', qty: 2, nested: { qty: 1 }, date: new Date(123), map: new Map([['a', { qty: 3 }]]), set: new Set([1]) };
  const entity = createEntity<typeof value, 'row'>('row')
    .events({ read(_state, _event: Event<{ id: string }>) {} })
    .commands((emit, context) => ({ set(state, payload: { id: string }) {
      expect(() => Reflect.set(state.nested, 'qty', 9)).toThrow();
      expect(state.date.getTime()).toBe(123);
      expect(Reflect.get(state.date, 'setTime')).toBeUndefined();
      expect(Reflect.get(state.map, 'set')).toBeUndefined();
      expect(Reflect.get(state.set, 'add')).toBeUndefined();
      expect(() => Reflect.set(state.map.get('a')!, 'qty', 9)).toThrow();
      expect(context.commands.next({ qty: state.qty })).toEqual({ command: 'next', payload: { qty: 2 } });
      return { events: [emit.read(payload)], intents: { audit: 'kept' } };
    } })).build();
  const host = createAggregate('store', { rows: [value] }).entityList('rows', entity).build();
  const events = host.process(host.initialState, host.commandCreators.rowsSet({ id: 'a' }));
  expect(Reflect.get(events, '__intents')).toEqual({ audit: 'kept' });
  expect(events[0]!.type).toBe('store.row.read.event');
  expect(value.nested.qty).toBe(1);
});

type Row = { id: string; code: string; domain: string; authority: string; qty: number };
const row = (id: string, qty: number): Row => ({ id, code: id, domain: id, authority: 'owner', qty });

function reader(called = jest.fn()) {
  return createEntity<Row, 'row'>('row').events({ read(_state, _event: Event<Record<string, unknown>>) {} })
    .selectors({ quantity: state => state.qty })
    .commands((emit, context) => ({ set(state, payload: Record<string, unknown>) {
      called();
      return emit.read({ ...payload, qty: context.selectors.quantity(state) });
    } })).build();
}

test('list declared single/composite PK and map own keys use selected state', () => {
  const entity = reader();
  const host = createAggregate('store', { codes: [row('a', 3)], composite: [row('a', 4)], byKey: { a: row('x', 5) } })
    .entityList('codes', entity, { pk: 'code' }, { semanticName: 'codes' })
    .entityList('composite', entity, { pk: ['domain', 'authority'] as const }, { semanticName: 'composite' })
    .entityMap('byKey', entity, {}, { semanticName: 'byKey' }).build();
  for (const [key, payload, qty] of [
    ['codesSet', { code: 'a', codesId: 'ordinary' }, 3],
    ['compositeSet', { domain: 'a', authority: 'owner', key: 'ordinary-value' }, 4],
    ['compositeSet', { domain: 'a', authority: 'owner', __entityPk: 'ordinary' }, 4],
    ['byKeySet', { key: 'a' }, 5]
  ] as const) {
    const events = host.process(host.initialState, { type: host.types.commands[key], payload });
    expect(events[0]!.payload).toEqual({ ...payload, qty });
  }
  expect(JSON.stringify(host.mounts)).toContain('commandTargets');
});

test('numeric/string identity equivalence is retained explicitly', () => {
  const host = createAggregate('store', { rows: [{ ...row('a', 3), code: 12 }] })
    .entityList('rows', reader(), { pk: 'code' }).build();
  expect(host.process(host.initialState, host.commandCreators.rowsSet({ code: '12' }))[0]!.payload).toEqual({ code: '12', qty: 3 });
});

test('compiled targets do not depend on entity names or overridden wire names', () => {
  const host = createAggregate('store', { stock: [row('a', 8)] })
    .entityList('stock', reader(), { pk: 'code' }, { commandNameOverrides: { set: 'legacy.unrelated.command' } }).build();
  const events = host.process(host.initialState, host.commandCreators.stockSet({ code: 'a' }));
  expect(host.commandCreators.stockSet({ code: 'a' }).type).toBe('legacy.unrelated.command');
  expect(events[0]!.payload).toEqual({ code: 'a', qty: 8 });
});

test('target dispatch follows last-wins wire registration, including later root commands', () => {
  type State = { rows: Row[]; qty: number };
  const entity = reader();
  const source = createMixin<State>().entityList('rows', entity).build();
  const mounted = { ...source, mountedEntities: [] };
  const root = createMixin<State>().events({ read(_state, _event: Event<number>) {} })
    .commands(emit => ({ rootRead(state, _payload: Record<string, unknown>) { return emit.read(state.qty); } })).build();
  const state = { rows: [row('a', 3)], qty: 99 };
  const overrides = { rowsSet: 'shared.command', rootRead: 'shared.command' };
  const rootLast = createAggregate('store', state).mixins(mounted, root).overrideCommandNames(overrides).build();
  expect(rootLast.process(state, rootLast.commandCreators.rowsSet({}))[0]!.payload).toBe(99);
  const mountedLast = createAggregate('store', state).mixins(root, mounted).overrideCommandNames(overrides).build();
  expect(mountedLast.process(state, mountedLast.commandCreators.rowsSet({ id: 'a' }))[0]!.payload).toEqual({ id: 'a', qty: 3 });
  const remounted = createAggregate('store', state).mixins(root, source).entityList('rows', entity).overrideCommandNames(overrides).build();
  expect(remounted.process(state, remounted.commandCreators.rowsSet({ id: 'a' }))[0]!.payload).toEqual({ id: 'a', qty: 3 });
});

test('a selected parent can register into an empty child collection', () => {
  const parent = createEntity<{ id: string; children: Row[] }, 'parent'>('parent')
    .entityList('children', reader())
    .events({ registered(state, event: Event<{ id: string; child: Row }>) { state.children.push(event.payload.child); } })
    .commands(emit => ({ register(state, payload: { id: string; child: Row }) {
      expect(state.children).toHaveLength(0);
      return emit.registered(payload);
    } })).build();
  const host = createAggregate('store', { parents: [{ id: 'p', children: [] as Row[] }] }).entityList('parents', parent).build();
  const event = host.process(host.initialState, host.commandCreators.parentsRegister({ id: 'p', child: row('c', 1) }))[0]!;
  expect(host.apply(host.initialState, event).parents[0]!.children).toEqual([row('c', 1)]);
});

test.each([
  {}, { id: 'missing' }, { rowsId: 'a' }, { id: null }, { id: undefined }
])('invalid target %j fails before domain work or writes', payload => {
  const called = jest.fn();
  const state = { rows: [row('a', 2)] };
  const host = createAggregate('store', state).entityList('rows', reader(called)).build();
  expect(() => host.process(state, host.commandCreators.rowsSet(payload))).toThrow('Invalid mounted command target');
  expect(called).not.toHaveBeenCalled();
  expect(state).toEqual({ rows: [row('a', 2)] });
});

test('missing containers, duplicate list identities, incomplete PK and inherited map entries reject', () => {
  const called = jest.fn();
  const host = createAggregate('store', { rows: [row('a', 2)], map: {} as Record<string, Row> })
    .entityList('rows', reader(called), { pk: ['domain', 'authority'] as const }).entityMap('map', reader(called)).build();
  const command = host.commandCreators.rowsSet({ domain: 'a', authority: 'owner' });
  expect(() => host.process({ rows: undefined, map: {} } as never, command)).toThrow('Invalid mounted command target');
  expect(() => host.process({ rows: [row('a', 1), row('a', 2)], map: {} }, command)).toThrow('Invalid mounted command target');
  expect(() => host.process(host.initialState, host.commandCreators.rowsSet({ domain: 'a' }))).toThrow('Invalid mounted command target');
  expect(() => host.process(host.initialState, host.commandCreators.mapSet({ key: 'toString' }))).toThrow('Invalid mounted command target');
  expect(called).not.toHaveBeenCalled();
});

test('nested list/map chains and mixin mounts resolve ancestors before children with local selectors', () => {
  const child = reader();
  const parent = createEntity<{ id: string; children: Row[]; byKey: Record<string, Row> }, 'parent'>('parent')
    .entityList('children', child, {}, { semanticName: 'children' }).entityMap('byKey', child, {}, { semanticName: 'byKey' })
    .selectors({ quantity: () => -1 }).build();
  const parents = [
    { id: 'p1', children: [row('same', 1)], byKey: { same: row('x', 11) } },
    { id: 'p2', children: [row('same', 2)], byKey: { same: row('x', 22) } }
  ];
  const mixin = createMixin<{ parents: typeof parents }>().entityList('parents', parent).build();
  const host = createAggregate('store', { parents, byParent: { p2: parents[1]! } })
    .mixins(mixin).entityMap('byParent', parent, {}, { semanticName: 'byParent' }).build();
  const cases = [
    ['parentsChildrenSet', { parentsId: 'p2', id: 'same' }, 2],
    ['parentsChildrenSet', { parentsId: 'p2', id: 'same', childrenId: 'ordinary' }, 2],
    ['parentsByKeySet', { parentsId: 'p2', key: 'same' }, 22],
    ['byParentChildrenSet', { byParentKey: 'p2', id: 'same' }, 2],
    ['byParentByKeySet', { byParentKey: 'p2', key: 'same' }, 22]
  ] as const;
  for (const [name, payload, qty] of cases) {
    const events = host.process(host.initialState, { type: host.types.commands[name], payload });
    expect(events[0]!.payload).toEqual({ ...payload, qty });
    expect(events[0]!.type).toBe(`store.${name.startsWith('parents') ? 'parent' : 'byParent'}.${name.includes('Children') ? 'children' : 'byKey'}.read.event`);
  }
  expect(() => host.process(host.initialState, { type: host.types.commands.parentsChildrenSet, payload: { id: 'same' } })).toThrow('Invalid mounted command target');
});

test.each(['list', 'map'] as const)('nested %s parents replay every child mount without touching siblings or root', kind => {
  const child = createEntity<{ id: string; qty: number }, 'child'>('child')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const parent = createEntity<{ id: string; children: { id: string; qty: number }[]; byKey: Record<string, { id: string; qty: number }> }, 'parent'>('parent')
    .entityList('children', child, {}, { semanticName: 'children' }).entityMap('byKey', child, {}, { semanticName: 'byKey' }).build();
  const parents = [1, 2].map(n => ({ id: `p${n}`, children: [{ id: 'same', qty: n }], byKey: { same: { id: 'same', qty: n } } }));
  const state = { qty: 99, parents, byParent: { p1: structuredClone(parents[0]!), p2: structuredClone(parents[1]!) } };
  const host = createAggregate('store', state).entityList('parents', parent).entityMap('byParent', parent, {}, { semanticName: 'byParent' }).build();
  for (const leaf of ['Children', 'ByKey'] as const) {
    const prefix = kind === 'list' ? 'parents' : 'byParent';
    const payload = { [kind === 'list' ? 'parentsId' : 'byParentKey']: 'p2', [leaf === 'Children' ? 'id' : 'key']: 'same' };
    const event = host.process(state, { type: host.types.commands[`${prefix}${leaf}Set`], payload })[0]!;
    const expected = structuredClone(state);
    const selected = kind === 'list' ? expected.parents[1]! : expected.byParent.p2;
    if (leaf === 'Children') selected.children[0]!.qty = 3;
    else selected.byKey.same!.qty = 3;
    expect(host.apply(state, event)).toEqual(expected);
    expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
  }
});

test.each([0, ''])('falsy identity %j survives qualified and unqualified list/map round trips', id => {
  const entity = createEntity<{ id: string | number; qty: number }, 'row'>('row')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const state = { qty: 99, rows: [{ id, qty: 2 }], byKey: { [id]: { id, qty: 2 } } };
  const host = createAggregate('store', state).entityList('rows', entity).entityMap('byKey', entity, {}, { semanticName: 'byKey' }).build();
  for (const [name, field] of [['rowsSet', 'id'], ['byKeySet', 'key']] as const) {
    const event = host.process(state, { type: host.types.commands[name], payload: { [field]: id } })[0]!;
    const expected = structuredClone(state);
    if (name === 'rowsSet') expected.rows[0]!.qty = 3;
    else expected.byKey[id]!.qty = 3;
    expect(host.apply(state, event)).toEqual(expected);
    expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
    expect(() => host.process(state, { type: host.types.commands[name], payload: { [field]: undefined } })).toThrow('Invalid mounted command target');
  }
});

test.each(['direct', 'mixin', 'nested'] as const)('repeated %s mounts retain surviving command registration targets', kind => {
  const called = jest.fn();
  const first = reader(called);
  const second = createEntity<Row, 'other'>('other').commands(() => ({ other() { return []; } })).build();
  const state = { qty: 99, rows: [row('a', 2)], parents: [{ id: 'p', rows: [row('a', 2)] }] };
  const mixin = createMixin<typeof state>().entityList('rows', first).entityMap('otherRows', second).entityList('rows', first).build();
  const parent = createEntity<typeof state.parents[number], 'parent'>('parent').entityList('rows', first).entityMap('otherRows', second).entityList('rows', first).build();
  const builder = createAggregate('store', state);
  const host = kind === 'direct' ? builder.entityList('rows', first).entityMap('otherRows', second).entityList('rows', first).build()
    : kind === 'mixin' ? builder.mixins(mixin).build() : builder.entityList('parents', parent).build();
  const name = kind === 'nested' ? 'parentsRowsSet' : 'rowsSet';
  const ancestor = kind === 'nested' ? { parentsId: 'p' } : {};
  expect(() => host.process(state, { type: host.types.commands[name], payload: ancestor })).toThrow('Invalid mounted command target');
  expect(called).not.toHaveBeenCalled();
  expect(host.process(state, { type: host.types.commands[name], payload: { ...ancestor, id: 'a' } })[0]!.payload).toEqual({ ...ancestor, id: 'a', qty: 2 });
});

test.each([0, ''])('undeclared targeted wires are unmatched even with valid identity %j', id => {
  const state = { qty: 99, rows: [{ id, qty: 2 }], byKey: { [id]: { id, qty: 2 } } };
  const unmatched = jest.fn();
  const host = createAggregate('store', state)
    .events({ changed(state, event: Event<{ qty: number }>) { Reflect.set(state, 'qty', event.payload.qty); } })
    .onUnmatchedEvent(unmatched).build();
  for (const [path, field] of [['rows', 'rowsId'], ['rows', 'id'], ['by_key', 'byKeyKey'], ['by_key', 'key']] as const) {
    const event = { type: `store.${path}.changed.event`, payload: { [field]: id, qty: 3 } };
    expect(host.apply(state, event)).toEqual(state);
    expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(state);
    expect(unmatched).toHaveBeenLastCalledWith(event.type, 'store');
  }
  expect(unmatched).toHaveBeenCalledTimes(8);
});

test('same-definition remount replaces list command targets with map targets', () => {
  const first = reader();
  const second = first;
  const state = { qty: 99, rows: { chosen: row('a', 7) } };
  const host = createAggregate('store', state).entityList('rows', first).entityMap('rows', second).build();
  expect(host.process(state, host.commandCreators.rowsSet({ key: 'chosen' }))[0]!.payload).toEqual({ key: 'chosen', qty: 7 });
  expect(() => host.process(state, host.commandCreators.rowsSet({ id: 'a' }))).toThrow('Invalid mounted command target');
});

test('scoped event wire collisions retain the last projector registration target', () => {
  const entity = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: { id: string }) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const state = { qty: 99, left: [{ id: 'a', qty: 2 }], right: [{ id: 'a', qty: 7 }] };
  const override = { semanticName: 'left', eventNameOverrides: { changed: 'custom.shared.event' } };
  const host = createAggregate('store', state).entityList('left', entity, {}, override)
    .entityList('right', entity, {}, { ...override, semanticName: 'right' }).entityList('left', entity, {}, override).build();
  const event = host.process(state, host.commandCreators.leftSet({ id: 'a' }))[0]!;
  expect(event.type).toBe('custom.shared.event');
  const expected = { ...state, left: [{ id: 'a', qty: 3 }] };
  expect(host.apply(state, event)).toEqual(expected);
  expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
});

function collisionHost(kind: 'direct' | 'mixin' | 'nested', alias: boolean, siblingId: string, called: () => void) {
  type Item = { id: string; qty: number };
  const changed = (state: Item, event: Event<Record<string, unknown> & { qty: number }>) => { state.qty = event.payload.qty; };
  const first = createEntity<Item, 'first'>('first').events({ bChanged: changed })
    .commands(emit => ({ bSet(state, payload: Record<string, unknown>) {
      called(); return emit.bChanged({ ...payload, qty: state.qty + 1 });
    } })).build();
  const second = createEntity<Item, 'second'>('second').events({ changed })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) {
      called(); return emit.changed({ ...payload, qty: state.qty + 1 });
    } })).build();
  const state = { id: 'p', a: [{ id: 'chosen', qty: 2 }], sibling: [{ id: siblingId, qty: 7 }] };
  const overrides = alias ? { commandNameOverrides: { bSet: 'custom.set.command' }, eventNameOverrides: { bChanged: 'custom.changed.event' } } : {};
  const mixin = createMixin<typeof state>().entityList('a', first, {}, overrides).entityList('sibling', second).entityList('a', first, {}, overrides).build();
  const parent = createEntity<typeof state, 'parent'>('parent').entityList('a', first, {}, overrides)
    .entityList('sibling', second).entityList('a', first, {}, overrides).build();
  const builder = createAggregate('store', { ...state, parents: [structuredClone(state)] });
  const host = kind === 'direct' ? builder.entityList('a', first, {}, overrides).entityList('sibling', second).entityList('a', first, {}, overrides).build()
    : kind === 'mixin' ? builder.mixins(mixin).build() : builder.entityList('parents', parent).build();
  return { host, name: kind === 'nested' ? 'parentsABSet' as const : 'aBSet' as const };
}

describe.each(['direct', 'mixin', 'nested'] as const)('A-B-A %s same-definition remounts', kind => {
  test.each([false, true])('winning provenance survives aliases=%s and same/different sibling IDs', alias => {
    for (const siblingId of ['chosen', 'sibling']) {
      const called = jest.fn();
      const { host, name } = collisionHost(kind, alias, siblingId, called);
      const state = host.initialState;
      const payload = { parentsId: 'p', id: 'chosen' };
      const event = host.process(state, { type: host.types.commands[name], payload })[0]!;
      expect(event.payload).toEqual({ ...payload, qty: 3 });
      const expected = structuredClone(state);
      (kind === 'nested' ? expected.parents[0]! : expected).a[0]!.qty = 3;
      expect(host.apply(state, event)).toEqual(expected);
      expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
      const missing = structuredClone(state);
      (kind === 'nested' ? missing.parents[0]! : missing).a = [];
      called.mockClear();
      expect(() => host.process(missing, { type: host.types.commands[name], payload })).toThrow('Invalid mounted command target');
      expect(called).not.toHaveBeenCalled();
      expect(host.initialState).toEqual(state);
    }
  });
});

test.each([false, true])('flattened mixin projector provenance survives cloning and repeated builds (override=%s)', override => {
  const called = jest.fn();
  const entity = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { called(); state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: { id: string }) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const state = { qty: 99, rows: [{ id: 'a', qty: 2 }] };
  const source = createMixin<typeof state>().entityList('rows', entity, {}, override ? { eventNameOverrides: { changed: 'custom.changed.event' } } : {}).build();
  const flattened = { ...source, mountedEntities: [] };
  const builder = createAggregate('store', state).mixins(flattened);
  for (const host of [builder.build(), builder.build(), createAggregate('store', state).mixins(source).build()]) {
    const event = host.process(state, host.commandCreators.rowsSet({ id: 'a' }))[0]!;
    expect(event.payload).toEqual({ id: 'a', qty: 3 });
    const expected = { qty: 99, rows: [{ id: 'a', qty: 3 }] };
    expect(host.apply(state, event)).toEqual(expected);
    expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
    called.mockClear();
    const missing = { qty: 99, rows: [] };
    expect(() => host.apply(missing, event)).toThrow('Invalid mounted command target');
    expect(() => host.applyToDraft(missing, event)).toThrow('Invalid mounted command target');
    expect(called).not.toHaveBeenCalled();
    expect(missing).toEqual({ qty: 99, rows: [] });
  }
});

test.each([false, true])('root projector replacement clears flattened provenance (override=%s)', override => {
  const entity = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } }).build();
  const state = { qty: 99, rows: [{ id: 'a', qty: 2 }] };
  const source = createMixin<typeof state>().entityList('rows', entity, {}, override ? { eventNameOverrides: { changed: 'custom.changed.event' } } : {}).build();
  const flattened = { ...source, mountedEntities: [] };
  const root = createMixin<typeof state>().events({ rowsChanged(state, event: Event<{ id: string; qty: number }>) {
    state.qty = event.payload.qty + 10;
  } }).build();
  const builder = createAggregate('store', state).mixins(flattened, root);
  for (const host of [builder.build(), builder.build()]) {
    const event = { type: host.types.events.rowsChanged, payload: { id: 'missing', qty: 3 } };
    const expected = { ...state, qty: 13 };
    expect(host.apply(state, event)).toEqual(expected);
    expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
  }
  const reversed = createAggregate('store', state).mixins(root, flattened).build();
  expect(reversed.apply(state, { type: reversed.types.events.rowsChanged, payload: { id: 'a', qty: 3 } }))
    .toEqual({ qty: 99, rows: [{ id: 'a', qty: 3 }] });
});

test('flattened resolved-wire collisions keep the winning projector and target together ahead of explicit roots', () => {
  const entity = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } }).build();
  const state = { qty: 99, left: [{ id: 'a', qty: 2 }], right: [{ id: 'a', qty: 7 }] };
  const override = { eventNameOverrides: { changed: 'custom.shared.event' } };
  const source = createMixin<typeof state>().entityList('left', entity, {}, override).entityList('right', entity, {}, override).build();
  const root = createMixin<typeof state>().events({ rootChanged(state, event: Event<{ id: string; qty: number }>) {
    state.qty = event.payload.qty + 10;
  } }, { eventNameOverrides: { rootChanged: 'custom.shared.event' } }).build();
  const host = createAggregate('store', state).mixins({ ...source, mountedEntities: [] }, root).build();
  const event = { type: 'custom.shared.event', payload: { id: 'a', qty: 3 } };
  const expected = { ...state, right: [{ id: 'a', qty: 3 }] };
  expect(host.apply(state, event)).toEqual(expected);
  expect(produce(state, draft => host.applyToDraft(draft, event))).toEqual(expected);
});

test('a reused command function retains independent registration targets', () => {
  const handler = (state: { qty: number }) => ({ type: 'read.event', payload: state.qty });
  const first = createEntity<{ id: string; qty: number }, 'first'>('first').commands(() => ({ bSet: handler })).build();
  const second = createEntity<{ id: string; qty: number }, 'second'>('second').commands(() => ({ set: handler })).build();
  const host = createAggregate('store', { a: [{ id: 'same', qty: 2 }], sibling: [{ id: 'same', qty: 7 }] })
    .entityList('a', first).entityList('sibling', second).entityList('a', first).entityList('other', first, {}, { semanticName: 'other' }).build();
  expect(host.process(host.initialState, host.commandCreators.aBSet({ id: 'same' }))[0]!.payload).toBe(2);
  expect(host.process(host.initialState, host.commandCreators.siblingSet({ id: 'same' }))[0]!.payload).toBe(7);
  expect(() => host.process(host.initialState, host.commandCreators.otherBSet({ id: 'same' }))).toThrow('Invalid mounted command target');
});
