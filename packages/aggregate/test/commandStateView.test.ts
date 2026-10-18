import { immerable } from 'immer';
import { commandStateView } from '../src/commandStateView';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

test.each([false, true])('command Date readers and mutation denial do not depend on mounting: %s', mounted => {
  const date = new Date(123);
  const template: { date: Date; nested: { date: Date }; dates: Date[]; optional?: Date; nullable: Date | null } = {
    date, nested: { date }, dates: [date], optional: date, nullable: date
  };
  const source = createAggregate('dated', template).events({ read() {} }).commands(emit => ({ read(state) {
    for (const view of [state.date, state.nested.date, ...state.dates, state.optional!, state.nullable!]) {
      expect(view.getTime()).toBe(123);
      expect(view.toISOString()).toBe(new Date(123).toISOString());
      expect(view.toJSON()).toBe(new Date(123).toJSON());
      expect(view[Symbol.toPrimitive]('number')).toBe(123);
      for (const name of Object.getOwnPropertyNames(Date.prototype).filter(key => key.startsWith('set'))) {
        expect(Reflect.get(view, name)).toBeUndefined();
        expect(() => Reflect.apply(Reflect.get(Date.prototype, name), view, [0])).toThrow(TypeError);
      }
    }
    expect(state.date).toBe(state.nested.date);
    return emit.read();
  } })).build();
  expect(Object.isFrozen(template)).toBe(false);
  const host = mounted ? source.withPlugins(createAggregatePluginFor(source, 'audit').state(() => ({})).build()) : source;
  expect(host.process(host.initialState, host.commandCreators.read())).toHaveLength(1);
  expect(date.getTime()).toBe(123);
  expect(Object.isFrozen(template)).toBe(false);
});

test('lazy facades preserve cycles, arrays, class readers and trusted callable identity', () => {
  class Model {
    [immerable] = true;
    date = new Date(123);
    dates = [this.date];
    self = this;
    fn = () => 3;
    read() { return this.date.getTime(); }
  }
  const model = Object.freeze(new Model());
  const view = commandStateView(model);
  expect(view).toBeInstanceOf(Model);
  expect(view.self).toBe(view);
  expect(view.fn).toBe(model.fn);
  expect(view.read()).toBe(123);
  expect(Array.isArray(view.dates)).toBe(true);
  expect(view.dates.map(date => date.getTime())).toEqual([123]);
  expect(Object.keys(view)).toEqual(Object.keys(model));
  expect(Object.getOwnPropertyDescriptor(view, 'date')?.get?.().getTime()).toBe(123);
  expect(() => Reflect.set(view.dates, '0', new Date(0))).toThrow();
  expect(() => Reflect.deleteProperty(view, 'date')).toThrow();
  expect(() => Reflect.defineProperty(view, 'date', { value: new Date(0) })).toThrow();
  expect(() => Object.preventExtensions(view)).toThrow();
  expect(model.date.getTime()).toBe(123);
});

test('command Date views retain invalid Date semantics and absent optional/nullable values', () => {
  const view = commandStateView({ date: new Date(NaN), optional: undefined, nullable: null });
  expect(view.date.getTime()).toBeNaN();
  expect(view.date.toJSON()).toBeNull();
  expect(() => view.date.toISOString()).toThrow(RangeError);
  expect(view.optional).toBeUndefined();
  expect(view.nullable).toBeNull();
});

test('frozen native collections retain their existing readonly reader operations', () => {
  const map = Object.freeze(new Map([['key', 123]]));
  const set = Object.freeze(new Set([123]));
  const view = commandStateView(Object.freeze({ map, set }));
  expect(view.map.get('key')).toBe(123);
  expect(view.set.has(123)).toBe(true);
  expect([...view.map]).toEqual([['key', 123]]);
  expect([...view.set]).toEqual([123]);
});

test.each([false, true])('native readers work in commands with shallow-frozen root: %s', frozen => {
  const template = { map: new Map([['key', 123]]), set: new Set([123]) };
  const source = createAggregate('collections', frozen ? Object.freeze(template) : template)
    .events({ read() {} }).commands(emit => ({ read(state) {
      expect(state.map.get('key')).toBe(123);
      expect(state.map.has('key')).toBe(true);
      expect([...state.map.entries()]).toEqual([['key', 123]]);
      expect([...state.map]).toEqual([['key', 123]]);
      expect(state.set.has(123)).toBe(true);
      expect([...state.set]).toEqual([123]);
      expect(state.map.size).toBe(1);
      expect(state.set.size).toBe(1);
      return emit.read();
    } })).build();
  expect(source.process(source.initialState, source.commandCreators.read())).toHaveLength(1);
});

test.each([false, true])('collection views wrap keys, values and callback receivers, frozen: %s', frozen => {
  const key = { id: 1 };
  const date = new Date(123);
  const value = { date };
  const map = new Map([[key, value]]);
  const set = new Set([value]);
  if (frozen) { Object.freeze(map); Object.freeze(set); }
  const view = commandStateView({ map, set, key, value, date });
  const [[viewKey, viewValue]] = [...view.map];
  expect(viewKey).toBe(view.key);
  expect(viewValue).toBe(view.value);
  expect(view.map.get(viewKey)).toBe(viewValue);
  expect(view.map.has(viewKey)).toBe(true);
  expect(view.map.has({ id: 1 })).toBe(false);
  expect(view.map.get({ id: 1 })).toBeUndefined();
  expect(view.map.has(commandStateView(key))).toBe(false);
  expect(view.set.has([...view.set][0]!)).toBe(true);
  expect(view.set.has({ date })).toBe(false);
  expect([...view.map.keys()]).toEqual([view.key]);
  expect([...view.map.values()]).toEqual([view.value]);
  expect([...view.set.entries()]).toEqual([[view.value, view.value]]);
  const context = {};
  view.map.forEach(function (this: unknown, item, itemKey, collection) {
    expect(this).toBe(context);
    expect(collection).toBe(view.map);
    expect(item).toBe(view.value);
    expect(itemKey).toBe(view.key);
    expect(() => Reflect.set(itemKey, 'id', 2)).toThrow(TypeError);
  }, context);
  view.set.forEach((item, itemKey, collection) => {
    expect(collection).toBe(view.set);
    expect(itemKey).toBe(item);
    expect(item).toBe(view.value);
  });
  expect(viewValue.date).toBe(view.date);
  expect(viewValue.date.getTime()).toBe(123);
  expect(Reflect.get(viewValue.date, 'setTime')).toBeUndefined();
  expect(() => Date.prototype.setTime.call(viewValue.date, 0)).toThrow(TypeError);
  expect(date.getTime()).toBe(123);
  expect(key.id).toBe(1);
});

test('collection facades do not expose native mutation receivers', () => {
  const key = { id: 1 };
  const value = { date: new Date(123) };
  const view = commandStateView({ map: new Map([[key, value]]), set: new Set([value]) });
  for (const collection of [view.map, view.set]) {
    for (const method of ['set', 'add', 'delete', 'clear']) expect(Reflect.get(collection, method)).toBeUndefined();
    expect(() => Reflect.set(collection, 'extra', 1)).toThrow(TypeError);
  }
  expect(() => Map.prototype.set.call(view.map, key, value)).toThrow(TypeError);
  expect(() => Set.prototype.add.call(view.set, value)).toThrow(TypeError);
});

test('collection aliases, cycles and Date keys round trip through a command view', () => {
  const date = new Date(123);
  const map = new Map<object, unknown>();
  map.set(date, map);
  const view = commandStateView({ map, alias: map, date, set: new Set([map, date]) });
  expect(view.map).toBe(view.alias);
  expect(view.map.get(view.date)).toBe(view.map);
  expect(view.set.has(view.map)).toBe(true);
  expect(view.set.has(view.date)).toBe(true);
  expect([...view.map.keys()][0]).toBe(view.date);
  expect(view.map.entries()[Symbol.iterator]().next().value).toEqual([view.date, view.map]);
});

test('command state Dates stay distinct from fixed-clock plugin envelope Dates', () => {
  const clock = jest.fn(() => new Date(456));
  const source = createAggregate('clock', { date: new Date(123) })
    .events({ read(_draft, _event: { type: string; payload: string }) {} })
    .commands(emit => ({ read(state) { return emit.read(state.date.toISOString()); } })).build();
  const host = source.withPlugins(createAggregatePlugin('stamp').state(() => ({}))
    .commandEnvelope(() => ({ commandDate: clock() }))
    .eventEnvelope((_input, context) => ({ commandDate: context.command.commandDate })).build());
  const command = host.prepareCommand(host.initialState, host.commandCreators.read());
  const event = host.process(host.initialState, command)[0]!;
  expect(event.payload).toBe(new Date(123).toISOString());
  expect(event.commandDate.getTime()).toBe(456);
  expect(command.commandDate.getTime()).toBe(456);
  expect(host.initialState.date.getTime()).toBe(123);
  expect(clock).toHaveBeenCalledTimes(1);
});
