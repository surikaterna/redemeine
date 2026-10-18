import { createAggregate, type AggregateStateView } from '../../../src';
import { createMirage, extractState } from '../../../../mirage/src';

const key = { date: new Date(123) };
const value = { count: 1, dates: new Set([key.date]) };
const source = createAggregate('mirageCollections', {
  key, invalidDate: new Date(NaN), map: new Map([[key, value]]), set: new Set([value])
}).events({ changed() {} }).commands(emit => ({ change: () => emit.changed() }))
  .selectors({ selected: state => state.map, computed: state => ({
    key: state.key, alias: state.key, map: new Map([[state.key, state.key]]), set: new Set([state.key]),
    date: state.key.date, dates: new Map([[state.key.date, state.key.date]]), dateSet: new Set([state.key.date]),
    invalid: state.invalidDate, invalidMap: new Map([[state.invalidDate, state.invalidDate]])
  }) }).build();
const live = createMirage(source, 'one');
const snapshot = extractState(live);
const state: AggregateStateView<typeof source.initialState> = snapshot;
const map: ReadonlyMap<AggregateStateView<typeof key>, AggregateStateView<typeof value>> = state.map;
const set: ReadonlySet<AggregateStateView<typeof value>> = state.set;
const viewKey = [...map.keys()][0]!;
if (!map.has(viewKey) || map.get(viewKey)?.count !== 1) throw new Error('Map key roundtrip');
if (!set.has([...set][0]!)) throw new Error('Set value roundtrip');
const selected = live.selected();
if (selected.get([...selected.keys()][0]!)?.count !== 1) throw new Error('Selector Map');
const computed = live.computed();
if (computed.key !== computed.alias || [...computed.map.keys()][0] !== computed.key) throw new Error('Computed sibling alias');
if (!computed.map.has(computed.key) || computed.map.get(computed.key) !== computed.key) throw new Error('Computed Map');
if (!computed.set.has([...computed.set][0]!) || !computed.set.has(computed.alias)) throw new Error('Computed Set');
if (typeof computed.date.getTime !== 'function' || computed.date.getTime() !== 123) throw new Error('Computed Date reader');
if (computed.dates.get([...computed.dates.keys()][0]!) !== computed.date || !computed.dateSet.has(computed.date)) throw new Error('Computed Date membership');
if (!Number.isNaN(computed.invalid.getTime()) || computed.invalidMap.get(computed.invalid) !== computed.invalid) throw new Error('Invalid Date alias');
computed.map.forEach((child, childKey, collection) => {
  if (child !== computed.key || collection.get(childKey) !== child) throw new Error('Computed callback identity');
});
const imported = createMirage(source, 'two', { snapshot });
const importedMap = imported.map;
if (importedMap.get([...importedMap.keys()][0]!)?.count !== 1) throw new Error('Snapshot reimport');
if (viewKey.date.getTime() !== 123) throw new Error('Date reader');
if (Reflect.get(map, 'set') !== undefined || Reflect.get(set, 'add') !== undefined) throw new Error('Native mutator exposed');
if (Reflect.get(viewKey.date, 'setTime') !== undefined) throw new Error('Date mutator exposed');
map.forEach((child, childKey, collection) => {
  if (collection !== map || childKey !== viewKey || child !== map.get(viewKey)) throw new Error('Map callback identity');
  if (Reflect.set(child, 'count', 2)) throw new Error('Writable Map child');
});
set.forEach((child, childKey, collection) => {
  if (collection !== set || child !== childKey) throw new Error('Set callback identity');
});
if (value.count !== 1 || key.date.getTime() !== 123) throw new Error('Input data changed');
function negative() {
  // @ts-expect-error computed selector collections remain readonly
  computed.map.set(key, key);
  // @ts-expect-error computed selector keys remain deeply readonly
  computed.key.date.setTime(0);
  // @ts-expect-error Map views do not expose native mutators
  live.map.set(key, value);
  // @ts-expect-error Set views do not expose native mutators
  snapshot.set.add(value);
  // @ts-expect-error map values are deeply readonly
  map.get(viewKey)!.count = 2;
  // @ts-expect-error map keys contain readonly Dates
  viewKey.date.setTime(0);
  // @ts-expect-error nested collections are readonly too
  map.get(viewKey)!.dates.clear();
  // @ts-expect-error callback collection arguments are readonly
  map.forEach((_value, _key, collection) => collection.clear());
  // @ts-expect-error set callback collection arguments are readonly
  set.forEach((_value, _key, collection) => collection.add(value));
}
void negative;
