import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, extractState, extractUncommittedEvents } from '../src';

test('root, entity, map and bound proxies support coercion without protocol side effects', async () => {
  const Item = createEntity<{ id: string }, 'item'>('item').events({}).commands(() => ({ touch: () => [] })).build();
  const builder = createAggregate('root', { items: [{ id: 'a' }], entries: { a: { id: 'a' } } })
    .entityList('items', Item).entityMap('entries', Item).events({}).commands(() => ({}))
    .selectors(({ bindContext }) => ({ selected: state => bindContext(state.items, Item) })).build();
  const live = createMirage(builder, 'one');
  for (const view of [live, live.items('a'), live.entries, live.entries.a!, live.selected()[0]!]) {
    expect(String(view)).toBe('[object Object]');
    expect(`${view}`).toBe('[object Object]');
    expect(Number(view)).toBeNaN();
    expect(view.toString()).toBe('[object Object]');
    expect(view.valueOf()).toBe(view);
    expect(await Promise.resolve(view)).toBe(view);
    for (const name of ['then', 'toJSON', 'inspect']) expect(Reflect.get(view, name)).toBeUndefined();
  }
  expect(String(live.items)).toBe('[object Object]');
  expect(extractUncommittedEvents(live)).toEqual([]);
});

test('subset roles use real selectors and command intents and cache names per mount', async () => {
  const Item = createEntity<{ id: string }, 'item'>('item').events({})
    .commands(() => ({ touch: () => [], other: () => [] })).build();
  let constructions = 0;
  const Role = createEntity<{ id: string }, 'role'>('role').events({})
    .selectors({ positive: state => state.id.length > 0 })
    .commands(() => ({ touch: () => [] }))
    .commands((_emit, ctx) => {
      constructions++;
      const intent = ctx.commands.touch();
      if (!ctx.selectors.positive({ id: 'a' }) || !intent) throw new Error('Missing construction context');
      return { touch: () => [] };
    }).build();
  const builder = createAggregate('root', { items: [{ id: 'a' }] }).entityList('items', Item)
    .events({}).commands(() => ({})).selectors(({ bindContext }) => ({
      selected: state => bindContext(state.items[0]!, Role, { mount: 'items' })
    })).build();
  const live = createMirage(builder, 'one');
  await live.selected().touch();
  expect(Reflect.get(live.selected(), 'other')).toBeUndefined();
  expect(constructions).toBe(1);
});

test('role construction sees real root selector results without leaking cache across builders', () => {
  const Item = createEntity<{ id: string }, 'item'>('item').events({})
    .commands(() => ({ touch: () => [], other: () => [] })).build();
  const Role = createEntity<{ id: string }, 'role'>('role').events({}).commands((_emit, ctx) => {
    const enabled = Reflect.get(ctx.selectors, 'enabled') as () => boolean;
    return { [enabled() ? 'touch' : 'other']: () => [] };
  }).build();
  const build = (enabled: boolean) => createAggregate('root', { items: [{ id: 'a' }] })
    .entityList('items', Item).events({}).commands(() => ({}))
    .selectors(({ bindContext }) => ({ enabled: () => enabled,
      selected: state => bindContext(state.items[0]!, Role, { mount: 'items' }) })).build();
  const first = createMirage(build(true), 'one').selected();
  const second = createMirage(build(false), 'two').selected();
  expect(typeof Reflect.get(first, 'touch')).toBe('function');
  expect(Reflect.get(first, 'other')).toBeUndefined();
  expect(typeof Reflect.get(second, 'other')).toBe('function');
  expect(Reflect.get(second, 'touch')).toBeUndefined();
});

test('role discovery uses the real emitter and isolates caches for mounts in the same builder', () => {
  const Item = createEntity<{ id: string }, 'item'>('item').events({ changed: () => {} })
    .commands(() => ({ touch: () => [], other: () => [] })).build();
  const Role = createEntity<{ id: string }, 'role'>('role').events({ changed: (_state, _event: Event<{ id: string }>) => {} })
    .commands(emit => ({ [emit.changed({ id: 'a' }).type.includes('.left.') ? 'touch' : 'other']: () => [] })).build();
  const builder = createAggregate('root', { left: [{ id: 'a' }], right: [{ id: 'a' }] })
    .entityList('left', Item, {}, { semanticName: 'left' }).entityList('right', Item, {}, { semanticName: 'right' }).events({}).commands(() => ({}))
    .selectors(({ bindContext }) => ({
      leftRole: state => bindContext(state.left[0]!, Role, { mount: 'left' }),
      rightRole: state => bindContext(state.right[0]!, Role, { mount: 'right' })
    })).build();
  const live = createMirage(builder, 'one');
  expect(typeof Reflect.get(live.leftRole(), 'touch')).toBe('function');
  expect(Reflect.get(live.leftRole(), 'other')).toBeUndefined();
  expect(typeof Reflect.get(live.rightRole(), 'other')).toBe('function');
  expect(Reflect.get(live.rightRole(), 'touch')).toBeUndefined();
  expect(extractUncommittedEvents(live)).toEqual([]);
});

test('subset roles cannot expose commands absent from their explicit mount', () => {
  const Item = createEntity<{ id: string }, 'item'>('item').events({}).commands(() => ({ touch: () => [] })).build();
  const Role = createEntity<{ id: string }, 'role'>('role').events({}).commands(() => ({ absent: () => [] })).build();
  const builder = createAggregate('root', { items: [{ id: 'a' }] }).entityList('items', Item)
    .events({}).commands(() => ({})).selectors(({ bindContext }) => ({
      selected: state => bindContext(state.items[0]!, Role, { mount: 'items' })
    })).build();
  expect(() => createMirage(builder, 'one').selected()).toThrow(/commands absent/);
});

test('map iteration returns readonly live entities and dispatches commands to each selected key', async () => {
  const Item = createEntity<{ qty: number }, 'entry'>('entry')
    .events({ changed: (state, event: Event<{ key: string; qty: number }>) => { state.qty = event.payload.qty; } })
    .commands(emit => ({ setQty: { pack: (key: string, qty: number) => ({ key, qty }),
      handler: (_state: unknown, payload: { key: string; qty: number }) => emit.changed(payload) } })).build();
  const builder = createAggregate('map', { entries: { a: { qty: 1 }, b: { qty: 2 } } })
    .entityMap('entries', Item, { knownKeys: ['a', 'b'] as const }).events({}).commands(() => ({})).build();
  const live = createMirage(builder, 'one');
  const items = [...live.entries];
  expect(items.map(item => item.qty)).toEqual([1, 2]);
  expect(() => Reflect.set(items[0]!, 'qty', 100)).toThrow();
  expect(() => Object.defineProperty(items[0]!, 'qty', { value: 100 })).toThrow();
  let qty = 5;
  for (const item of live.entries) {
    const result = await item.setQty(qty++);
    expect(() => Reflect.set(result, 'qty', 100)).toThrow();
  }
  expect(items.map(item => item.qty)).toEqual([5, 6]);
  expect(extractState(live).entries).toEqual({ a: { qty: 5 }, b: { qty: 6 } });
  expect(extractUncommittedEvents(live).map(event => event.payload)).toEqual([{ key: 'a', qty: 5 }, { key: 'b', qty: 6 }]);
  const empty = createMirage(createAggregate('empty', { entries: {} }).entityMap('entries', Item)
    .events({}).commands(() => ({})).build(), 'empty');
  expect([...empty.entries]).toEqual([]);
});
