import { createAggregate, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, extractState, subscribe } from '../src';
import { readonlySnapshot, cloneState } from '../src/stateViews';
import { runInNewContext } from 'node:vm';

test.each([false, true])('commands read Dates from Mirage cloned input, mounted=%s', async mounted => {
  const date = new Date(123);
  const template: { date: Date; nested: { date: Date }; dates: Date[]; optional?: Date; nullable: Date | null } = {
    date, nested: { date }, dates: [date], optional: date, nullable: date
  };
  const source = createAggregate('commandDates', template).events({ read() {} }).commands(emit => ({ read(state) {
    for (const view of [state.date, state.nested.date, ...state.dates, state.optional!, state.nullable!]) {
      expect(view.getTime()).toBe(123);
      expect(view.toISOString()).toBe(new Date(123).toISOString());
      expect(Reflect.get(view, 'setTime')).toBeUndefined();
      expect(() => Date.prototype.setTime.call(view, 0)).toThrow(TypeError);
    }
    return emit.read();
  } })).build();
  const host = mounted ? source.withPlugins(createAggregatePluginFor(source, 'audit').state(() => ({})).build()) : source;
  const live = createMirage(host, `command-${mounted}`);
  const next = await live.read();
  expect(next.date.getTime()).toBe(123);
  expect(live.date.getTime()).toBe(123);
  expect(extractState(live).nested.date.getTime()).toBe(123);
  expect(date.getTime()).toBe(123);
});

test('model-aware Mirage accepts core views and exposes callable Date readers across dispatch', async () => {
  const template = { dates: [new Date(123)], labels: [] as string[] };
  const source = createAggregate('dated', template).events({ changed(draft, event: Event<string>) {
    draft.labels.push(event.payload);
  } }).commands(emit => ({ change: (_state, label: string) => emit.changed(label) })).build();
  const plugin = createAggregatePluginFor(source, 'audit').state(() => ({ count: 0 }))
    .events({ changed(draft, _event, context) {
      expect(context.state.dates[0]?.getTime()).toBe(123);
      draft.count++;
    } }).build();
  const host = source.withPlugins(plugin);
  const live = createMirage(host, 'one', { snapshot: host.initialState });
  expect(live.dates[0]?.toISOString()).toBe(new Date(123).toISOString());
  let notified = 0;
  subscribe(live, state => { expect(state.dates[0]?.getTime()).toBe(123); notified++; });
  const result = await live.change('label');
  expect(result.dates[0]?.getTime()).toBe(123);
  expect(result.labels).toEqual(['label']);
  expect(extractState(live).audit.count).toBe(1);
  expect(notified).toBe(1);
  expect(template.labels).toEqual([]);
});

test('direct, nested and array Dates expose native readers without mutable aliases', async () => {
  const initialDate = new Date(123);
  const source = createAggregate('dates', {
    date: initialDate, nested: { date: initialDate }, dates: [initialDate]
  }).events({ changed(draft, event: Event<number>) {
    draft.date = new Date(event.payload);
  } }).commands(emit => ({ change: (_state, time: number) => emit.changed(time) })).build();
  const live = createMirage(source, 'one');
  const oldDate = live.date;
  const oldState = extractState(live);
  for (const date of [live.date, live.nested.date, live.dates[0]!, oldState.date]) {
    expect(date.getTime()).toBe(123);
    expect(date.toISOString()).toBe(initialDate.toISOString());
    expect(date.toJSON()).toBe(initialDate.toJSON());
    expect(date.toString()).toBe(initialDate.toString());
    expect(date.valueOf()).toBe(123);
    expect(date[Symbol.toPrimitive]('number')).toBe(123);
    expect(String(date)).toBe(String(initialDate));
    expect(JSON.stringify(date)).toBe(JSON.stringify(initialDate));
    for (const name of Object.getOwnPropertyNames(Date.prototype).filter(name => name.startsWith('set'))) {
      expect(Reflect.get(date, name)).toBeUndefined();
      expect(() => Reflect.apply(Reflect.get(Date.prototype, name), date, [0])).toThrow(TypeError);
    }
    expect(() => Reflect.set(date, 'extra', 1)).toThrow();
    expect(() => Reflect.defineProperty(date, 'setTime', { value: () => 0 })).toThrow();
    expect(() => Reflect.setPrototypeOf(date, {})).toThrow();
    expect(date.getTime()).toBe(123);
  }
  expect(initialDate.getTime()).toBe(123);
  const next = await live.change(456);
  expect(next.date.getTime()).toBe(456);
  expect(live.date.getTime()).toBe(456);
  expect(oldDate.getTime()).toBe(123);
  expect(oldState.date.getTime()).toBe(123);
  expect(cloneState(oldState).date.getTime()).toBe(123);
});

test('snapshot Dates support intrinsic cross-realm brands and invalid Date semantics', () => {
  const foreign: Date = runInNewContext('new Date(123)');
  expect(readonlySnapshot(foreign).toISOString()).toBe(new Date(123).toISOString());
  const invalid = readonlySnapshot(new Date(NaN));
  expect(invalid.getTime()).toBeNaN();
  expect(invalid.toJSON()).toBeNull();
  expect(() => invalid.toISOString()).toThrow(RangeError);
});
