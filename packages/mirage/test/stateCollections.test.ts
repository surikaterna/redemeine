import { runInNewContext } from 'node:vm';
import { createAggregate, type AggregateStateView } from '@redemeine/aggregate';
import { createMirage, extractState, subscribe } from '../src';
import { cloneState, readonlySelectorResult, readonlySnapshot } from '../src/stateViews';

function model() {
  const key = { label: 'key', date: new Date(123) };
  const value = { count: 1, date: key.date, nested: new Set([key]) };
  return { count: 0, key, map: new Map([[key, value]]), set: new Set([value]) };
}
type Model = ReturnType<typeof model>;
type View = AggregateStateView<Model>;

test.each([['object', { label: 'key' }], ['Date', new Date(123)], ['invalid Date', new Date(NaN)]] as const)(
  'computed collections preserve %s sibling and iterated key membership', (_name, key) => {
    const source = createAggregate('computedKeys', { key }).selectors({ computed: state => ({
      key: state.key, alias: state.key,
      map: new Map([[state.key, 1]]), set: new Set([state.key])
    }) }).build();
    const result = createMirage(source, 'one').computed();
    expect(result.key).toBe(result.alias);
    expect([...result.map.keys()][0]).toBe(result.key);
    expect([...result.set][0]).toBe(result.key);
    expect(result.map.has(result.key)).toBe(true);
    expect(result.map.get(result.key)).toBe(1);
    expect(result.set.has(result.key)).toBe(true);
    result.map.forEach((value, child, collection) => {
      expect(child).toBe(result.key);
      expect(collection.get(child)).toBe(value);
    });
    result.set.forEach((child, alias, collection) => {
      expect(child).toBe(alias);
      expect(collection.has(child)).toBe(true);
    });
    checkMutation(result.map, 'Map'); checkMutation(result.set, 'Set');
    if (key instanceof Date && 'getTime' in result.key) {
      expect(typeof result.key.getTime).toBe('function');
      expect(result.key.getTime()).toBe(key.getTime());
      expect(() => Date.prototype.setTime.call(result.key, 0)).toThrow(TypeError);
    } else expect(Reflect.set(result.key, 'label', 'changed')).toBe(false);
  }
);

test.each([{ label: 'key' }, new Date(123), new Date(NaN)])(
  'computed collections retain distinct pristine and readonly keys: %p', raw => {
    const readonly = readonlySelectorResult(raw);
    const map = new Map([[raw, 'pristine'], [readonly, 'readonly']]);
    const set = new Set([raw, readonly]);
    const result = readonlySelectorResult({ map, set }) as {
      map: ReadonlyMap<unknown, string>; set: ReadonlySet<unknown>;
    };
    const keys = [...result.map.keys()];
    expect(result.map.size).toBe(2);
    expect(result.set.size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(result.map.get(raw)).toBe('pristine');
    expect(result.map.get(readonly)).toBe('readonly');
    expect(keys.map(key => result.map.get(key))).toEqual(['pristine', 'readonly']);
    expect([...result.map.values()]).toEqual(['pristine', 'readonly']);
    for (const key of keys) expect(result.map.has(key)).toBe(true);
    for (const key of result.set) expect(result.set.has(key)).toBe(true);
    expect([...result.set]).toEqual(keys);
    expect(result.set.has(raw)).toBe(true);
    expect(result.set.has(readonly)).toBe(true);
    expect(map.size).toBe(2);
    expect(set.size).toBe(2);
  }
);

function checkMap(map: View['map']) {
  expect(map.size).toBe(1);
  const key = [...map.keys()][0]!;
  const value = map.get(key)!;
  expect(map.has(key)).toBe(true);
  expect([...map.values()][0]).toBe(value);
  expect([...map][0]).toEqual([key, value]);
  expect([...map.entries()][0]).toEqual([key, value]);
  expect(Object.keys(key)).toEqual(['label', 'date']);
  expect(key.date.getTime()).toBe(123);
  expect(value.date).toBe(key.date);
  expect(value.nested.has(key)).toBe(true);
  expect([...value.nested][0]).toBe(key);
  const context = {};
  map.forEach(function (this: object, child, childKey, collection) {
    expect(this).toBe(context);
    expect(collection).toBe(map);
    expect(child).toBe(value);
    expect(childKey).toBe(key);
    expect(Reflect.get(collection, 'set')).toBeUndefined();
  }, context);
  expect(Reflect.set(key, 'label', 'changed')).toBe(false);
  expect(Reflect.set(value, 'count', 2)).toBe(false);
  expect(() => Date.prototype.setTime.call(value.date, 0)).toThrow(TypeError);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'date')!;
  expect(descriptor.value).toBe(value.date);
  expect(descriptor.writable).toBe(false);
}

function checkSet(set: View['set']) {
  expect(set.size).toBe(1);
  const value = [...set][0]!;
  expect(set.has(value)).toBe(true);
  expect([...set.keys()][0]).toBe(value);
  expect([...set.values()][0]).toBe(value);
  expect([...set.entries()][0]).toEqual([value, value]);
  set.forEach((child, key, collection) => {
    expect(child).toBe(value);
    expect(key).toBe(value);
    expect(collection).toBe(set);
    expect(Reflect.get(collection, 'add')).toBeUndefined();
  });
  expect(value.date.getTime()).toBe(123);
  expect(Reflect.set(value, 'count', 2)).toBe(false);
}

function checkMutation(collection: object, kind: 'Map' | 'Set') {
  for (const name of [kind === 'Map' ? 'set' : 'add', 'delete', 'clear']) {
    expect(Reflect.get(collection, name)).toBeUndefined();
    const method: unknown = Reflect.get(kind === 'Map' ? Map.prototype : Set.prototype, name);
    expect(() => Reflect.apply(method as Function, collection, [1, 2])).toThrow(TypeError);
  }
  expect(() => Reflect.set(collection, 'extra', {})).toThrow();
  expect(() => Reflect.defineProperty(collection, 'extra', { value: {} })).toThrow();
  expect(() => Reflect.deleteProperty(collection, 'extra')).toThrow();
  expect(() => Reflect.setPrototypeOf(collection, {})).toThrow();
  expect(() => Reflect.preventExtensions(collection)).toThrow();
  expect(Reflect.ownKeys(collection)).toEqual([]);
  expect(Object.getOwnPropertyDescriptor(collection, 'size')).toBeUndefined();
  expect(() => Reflect.apply(Object.getOwnPropertyDescriptor(kind === 'Map' ? Map.prototype : Set.prototype, 'size')!.get!, collection, [])).toThrow(TypeError);
}

test('native collection leaves work through live, extracted, selector, command-result and subscription views', async () => {
  const initial = model();
  const source = createAggregate('collections', initial).events({ changed(draft) {
    draft.count++;
    const replacement = model();
    replacement.map.get(replacement.key)!.count = 2;
    draft.map = replacement.map;
  } })
    .commands(emit => ({ change: () => emit.changed() }))
    .selectors({ selected: state => state.map, computed: state => ({ maps: [state.map], get set() { return state.set; } }) }).build();
  const live = createMirage(source, 'one');
  const old = extractState(live);
  for (const map of [live.map, old.map, live.selected(), live.computed().maps[0]!]) {
    checkMap(map); checkMutation(map, 'Map');
  }
  for (const set of [live.set, old.set, live.computed().set]) { checkSet(set); checkMutation(set, 'Set'); }
  expect(old.map.get(old.key)).toBe([...old.set][0]);
  let notified = 0;
  subscribe(live, state => { checkMap(state.map); checkSet(state.set); notified++; });
  const next = await live.change();
  checkMap(next.map);
  expect([...next.map.values()][0]?.count).toBe(2);
  expect([...old.map.values()][0]?.count).toBe(1);
  expect(next.count).toBe(1);
  expect(old.count).toBe(0);
  expect(notified).toBe(1);
  expect(initial.count).toBe(0);
  expect(initial.map.get(initial.key)?.count).toBe(1);
  expect(initial.key.date.getTime()).toBe(123);
  const imported = createMirage(source, 'two', { snapshot: old });
  checkMap(imported.map);
  await imported.change();
  expect(extractState(live).count).toBe(1);
  expect(old.count).toBe(0);
});

test.each(['Map', 'Set'] as const)('direct cyclic foreign-realm %s snapshots keep aliases and pristine reimport data', kind => {
  const input: Map<object, unknown> | Set<unknown> = runInNewContext(kind === 'Map'
    ? '(() => { const m = new Map(); m.set(m, m); return m; })()'
    : '(() => { const s = new Set(); s.add(s); return s; })()');
  const view = readonlySnapshot(input);
  expect(view.size).toBe(1);
  const key = [...view.keys()][0]!;
  expect(key).toBe(view);
  expect(view.has(key)).toBe(true);
  if ('get' in view) expect(view.get(key)).toBe(view);
  checkMutation(view, kind);
  const clone = cloneState(view);
  expect(clone).not.toBe(input);
  expect([...clone.keys()][0]).toBe(clone);
  clone.clear();
  expect(view.size).toBe(1);
  expect(input.size).toBe(1);
});

test('nested collection snapshots keep Date keys, aliases, cycles and array reflection safe', () => {
  const date = new Date(123);
  const map = new Map<unknown, unknown>();
  const set = new Set<unknown>([date, map]);
  map.set(date, set);
  map.set(map, map);
  const view = readonlySnapshot({ map, set, date, array: [map] });
  expect(view.map.get(view.date)).toBe(view.set);
  expect(view.set.has(view.date)).toBe(true);
  expect(view.set.has(view.map)).toBe(true);
  expect(view.map.get(view.map)).toBe(view.map);
  expect(view.array[0]).toBe(view.map);
  expect(Object.keys(view.array)).toEqual(['0']);
  expect(() => Array.prototype.push.call(view.array, 1)).toThrow();
  expect(Reflect.setPrototypeOf(view.array, {})).toBe(false);
  expect(Reflect.get(view.date, 'setTime')).toBeUndefined();
  expect(() => Date.prototype.setTime.call(view.date, 0)).toThrow(TypeError);
  const copy = cloneState(view);
  expect(copy.map.get(copy.date)).toBe(copy.set);
  expect(copy.map.get(copy.map)).toBe(copy.map);
  expect(copy.array[0]).toBe(copy.map);
  copy.map.clear(); copy.set.clear(); copy.date.setTime(456);
  expect(view.map.size).toBe(2);
  expect(view.date.getTime()).toBe(123);
  expect(map.size).toBe(2);
});
