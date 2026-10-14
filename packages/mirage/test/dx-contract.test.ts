import { createAggregate, createEntity, bindContext } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, createDepot, dispatch, extractState, extractUncommittedEvents, subscribe, MirageCoreSymbol } from '../src';

const role = (name: string) => createEntity<{ id: string; qty: number }, string>(name)
  .events({ changed: (state, event: Event<{ id: string; qty: number }>) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ setQty: {
    pack: (id: string, qty: number) => ({ id, qty }),
    handler: (_state: unknown, payload: { id: string; qty: number }) => emit.changed(payload)
  } })).build();

const Line = role('line');
function definition() {
  return createAggregate('order', { total: 0, lines: [{ id: 'one', qty: 1 }] })
    .entityList('lines', Line)
    .events({ added: (state, event: Event<number>) => { state.total += event.payload; } })
    .commands(emit => ({ add: (_state, value: number) => emit.added(value), noop: () => [] }))
    .selectors({ count: state => state.total, find: (state, id: string) => state.lines.find(line => line.id === id) })
    .build();
}

test('zero-event returns, subscriptions and supplied snapshots are readonly and isolated', async () => {
  const builder = definition();
  const snapshot = { total: 0, lines: [{ id: 'one', qty: 1 }] };
  const first = createMirage(builder, 'one', { snapshot });
  const second = createMirage(builder, 'two');
  snapshot.lines[0]!.qty = 88;
  expect(first.lines('one').qty).toBe(1);
  const result = await first.noop();
  expect(() => Reflect.set(result, 'total', 99)).toThrow();
  const seen: unknown[] = [];
  subscribe(first, state => {
    seen.push(state);
    expect(() => Reflect.set(state, 'total', 99)).toThrow();
  });
  await first.noop();
  expect(seen).toHaveLength(1);
  expect(first.total).toBe(0);
  expect(second.total).toBe(0);
  expect(builder.initialState.total).toBe(0);
  expect(extractUncommittedEvents(first)).toEqual([]);
  expect(Reflect.get(first, MirageCoreSymbol).version).toBe(0);
  const descriptor = Object.getOwnPropertyDescriptor(extractState(first), 'lines');
  expect(Reflect.set(descriptor?.value[0], 'qty', 99)).toBe(false);
  expect(first.lines('one').qty).toBe(1);
});

test.each(['iterate', 'filter', 'find', 'at', 'map'] as const)('%s exposes readonly scoped proxies', async mode => {
  const live = createMirage(definition(), 'one');
  const item = mode === 'iterate' ? [...live.lines][0] : mode === 'filter' ? live.lines.filter(() => true)[0]
    : mode === 'find' ? live.lines.find(() => true) : mode === 'at' ? live.lines.at(-1) : live.lines.map(x => x)[0];
  expect(item).toBeDefined();
  expect(() => Reflect.set(item!, 'qty', 7)).toThrow();
  const returned = await item!.setQty(4);
  expect(returned.qty).toBe(4);
  expect(() => Reflect.set(returned, 'qty', 7)).toThrow();
  expect(live.lines('one').qty).toBe(4);
  expect(extractUncommittedEvents(live)).toHaveLength(1);
});

test('collection mutators and reflection cannot mutate state', () => {
  const live = createMirage(definition(), 'one');
  for (const method of ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']) {
    expect(() => Reflect.get(live.lines, method)()).toThrow();
  }
  expect(() => Object.defineProperty(live.lines('one'), 'qty', { value: 99 })).toThrow();
  expect(() => Object.setPrototypeOf(live, {})).toThrow();
  expect(live.lines('one').qty).toBe(1);
});

test('binding selects the declared role rather than the first matching key shape', async () => {
  const Billing = role('billing'), Shipping = role('shipping');
  const builder = createAggregate('order', { billing: [{ id: 'same', qty: 1 }], shipping: [{ id: 'same', qty: 5 }] })
    .entityList('billing', Billing).entityList('shipping', Shipping).events({}).commands(() => ({}))
    .selectors(({ bindContext }) => ({ shippingItem: state => bindContext(state.shipping[0]!, Shipping),
      wrongMount: state => bindContext(state.shipping[0]!, Shipping, { mount: 'billing' }) })).build();
  const live = createMirage(builder, 'one');
  expect(live.shippingItem().qty).toBe(5);
  await live.shippingItem().setQty(9);
  expect(live.billing('same').qty).toBe(1);
  expect(live.shipping('same').qty).toBe(9);
  expect(() => live.wrongMount()).toThrow(/does not match/);
});

test('reused entity definitions require explicit mount disambiguation', () => {
  const builder = createAggregate('order', { left: [{ id: 'same', qty: 1 }], right: [{ id: 'same', qty: 5 }] })
    .entityList('left', Line).entityList('right', Line).events({}).commands(() => ({}))
    .selectors({ ambiguous: state => bindContext(state.right[0]!, Line),
      explicit: state => bindContext(state.right[0]!, Line, { mount: 'right' }) }).build();
  const live = createMirage(builder, 'one');
  expect(() => live.ambiguous()).toThrow(/ambiguous/i);
  expect(live.explicit().qty).toBe(5);
});

test('Depot preserves full selectors and refuses instances of another builder', async () => {
  const builder = definition();
  const store = { async *readStream() {}, saveEvents: jest.fn(async () => {}) };
  const depot = createDepot(builder, store);
  const live = await depot.get('one');
  expect(live.count()).toBe(0);
  expect(live.find('one')?.qty).toBe(1);
  await expect(depot.save(createMirage(definition(), 'other'))).rejects.toThrow(/builder/i);
  expect(store.saveEvents).not.toHaveBeenCalled();
});

test('typed selectors retain defaults/rest arguments without arity-based utility injection', () => {
  const builder = createAggregate('a', { total: 2 }).events({}).commands(() => ({}))
    .selectors({ lookup: (state, prefix = 'value', ...suffixes: string[]) => `${prefix}:${state.total}:${suffixes.join(',')}` }).build();
  const live = createMirage(builder, 'one');
  expect(live.lookup()).toBe('value:2:');
  expect(live.lookup('x', 'a', 'b')).toBe('x:2:a,b');
});

test('collisions and unsafe protocol command names refuse construction', () => {
  const stateCollision = createAggregate('a', { total: 2 }).events({}).commands(() => ({}))
    .selectors({ total: state => state.total }).build();
  expect(() => createMirage(stateCollision, 'one')).toThrow(/collision/i);
  const protocol = createAggregate('a', {}).events({}).commands(() => ({
    // biome-ignore lint/suspicious/noThenProperty: Verify protocol-name collisions refuse construction.
    then: () => []
  })).build();
  expect(() => createMirage(protocol, 'one')).toThrow(/then/);
  const reservedEntity = createEntity<{ id: string }, 'entity'>('entity').events({}).commands(() => ({
    // biome-ignore lint/suspicious/noThenProperty: Empty mounts must still reject protocol command names.
    then: () => []
  })).build();
  const empty = createAggregate('a', { items: [] as { id: string }[] }).entityList('items', reservedEntity).events({}).commands(() => ({})).build();
  expect(() => createMirage(empty, 'one')).toThrow(/then/);
});

test('raw dispatch keeps readonly returns and rejects malformed envelopes', async () => {
  const builder = definition(), live = createMirage(builder, 'one');
  const result = await dispatch(live, builder.commandCreators.add(2));
  expect(result.total).toBe(2);
  expect(() => Reflect.set(result, 'total', 99)).toThrow();
  expect(extractState(live).total).toBe(2);
  expect(() => Reflect.apply(dispatch, undefined, [live, 123])).toThrow(/command envelope/);
});

test('map commands require a selected key and return readonly entity state', async () => {
  const entry = createEntity<{ qty: number }, 'entry'>('entry')
    .events({ changed: (state, event: Event<{ key: string; qty: number }>) => { state.qty = event.payload.qty; } })
    .commands(emit => ({ setQty: { pack: (key: string, qty: number) => ({ key, qty }),
      handler: (_state: unknown, payload: { key: string; qty: number }) => emit.changed(payload) } })).build();
  const entries = { one: { qty: 0 },
    // biome-ignore lint/suspicious/noThenProperty: A map key holding a non-callable entity is not a Promise hook.
    then: { qty: 7 }
  };
  const builder = createAggregate('map', { entries }).entityMap('entries', entry, { knownKeys: ['one', 'then'] as const })
    .events({}).commands(() => ({})).build();
  const live = createMirage(builder, 'one');
  expect(Reflect.get(live.entries, 'setQty')).toBeUndefined();
  expect(Reflect.get(live.entries, 'missing')).toBeUndefined();
  expect((await live.entries).then.qty).toBe(7);
  const result = await live.entries.one.setQty(3);
  expect(result.qty).toBe(3);
  expect(() => Reflect.set(result, 'qty', 99)).toThrow();
  expect(extractUncommittedEvents(live)).toHaveLength(1);
});

test('explicit custom keys resolve the configured field and missing selections fail', () => {
  const entity = createEntity<{ code: string; qty: number }, 'entry'>('entry').events({}).commands(() => ({})).build();
  const builder = createAggregate('a', { entries: [{ code: 'A', qty: 1 }, { code: 'B', qty: 2 }] })
    .entityList('entries', entity, { pk: 'code' }).events({}).commands(() => ({})).build();
  const live = createMirage(builder, 'one');
  expect(live.entries('B').qty).toBe(2);
  expect(() => live.entries('missing')).toThrow(/not found/);
  expect(live.entries.at(3)).toBeUndefined();
  expect(Reflect.get(live.entries('B'), 'notACommand')).toBeUndefined();
});

test('pending event extraction and diagnostics cannot mutate the internal core', async () => {
  const builder = definition(), live = createMirage(builder, 'one');
  await live.add(2);
  const events = extractUncommittedEvents(live);
  events[0]!.payload = 100;
  expect(extractUncommittedEvents(live)[0]!.payload).toBe(2);
  const diagnostics = Reflect.get(live, MirageCoreSymbol);
  expect(diagnostics.state).toBeUndefined();
  expect(Reflect.set(diagnostics, 'version', 100)).toBe(false);
  expect(diagnostics.version).toBe(1);
  const copy = createMirage(builder, 'copy', { snapshot: extractState(live), initialVersion: 1 });
  await copy.add(3);
  expect(copy.total).toBe(5);
  expect(live.total).toBe(2);
});

test('composite-key encoding cannot collide on delimiters and bound selectors inject every key', async () => {
  const Entity = createEntity<{ a: string; b: string; qty: number }, 'pair'>('pair')
    .events({ changed: (state, event: Event<{ a: string; b: string; qty: number }>) => { state.qty = event.payload.qty; } })
    .commands(emit => ({ setQty: { pack: (a: string, b: string, qty: number) => ({ a, b, qty }),
      handler: (_state: unknown, payload: { a: string; b: string; qty: number }) => emit.changed(payload) } })).build();
  const builder = createAggregate('pairs', { entries: [{ a: 'x|b:y', b: 'z', qty: 1 }, { a: 'x', b: 'y|b:z', qty: 2 }] })
    .entityList('entries', Entity, { pk: ['a', 'b'] as const }).events({}).commands(() => ({}))
    .selectors(({ bindContext }) => ({ selected: state => bindContext(state.entries, Entity, { mount: 'entries' }) })).build();
  const live = createMirage(builder, 'one');
  expect(live.entries({ a: 'x|b:y', b: 'z' }).qty).toBe(1);
  expect(live.entries({ a: 'x', b: 'y|b:z' }).qty).toBe(2);
  await live.selected()[1]!.setQty(9);
  expect(live.entries({ a: 'x|b:y', b: 'z' }).qty).toBe(1);
  expect(live.entries({ a: 'x', b: 'y|b:z' }).qty).toBe(9);
});
