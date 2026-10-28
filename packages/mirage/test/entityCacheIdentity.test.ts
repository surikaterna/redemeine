import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, extractState, MirageCoreSymbol } from '../src';
import { findEntityInCollection } from '../src/proxy/entityCache';

type Scalar = string | number | bigint;
type Row = { id: Scalar; code: Scalar; domain: Scalar; authority: Scalar; qty: number };
const values = [0, 0n, 9007199254740992n, 9007199254740993n] as const;

function fixture(pk: 'id' | 'code' | readonly ['domain', 'authority'], value: Scalar) {
  const rows: Row[] = [
    { id: value, code: value, domain: value, authority: 'a', qty: 1 },
    { id: 'other', code: 'other', domain: 'other', authority: 'a', qty: 10 }
  ];
  const item = createEntity<Row, 'item'>('item')
    .events({ changed(state, event: { payload: { qty: number } }) { state.qty = event.payload.qty; } })
    .commands(emit => ({ add: (state, payload: { qty: number }) => emit.changed({ ...payload, qty: state.qty + payload.qty }) })).build();
  const host = createAggregate('store', { rows }).entityList('rows', item, { pk })
    .events({ replaced(state, event: { payload: { rows: Row[] } }) { state.rows = event.payload.rows; } })
    .commands(emit => ({ replace: (_state, payload: { rows: Row[] }) => emit.replaced(payload) }))
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], item, { mount: 'rows' }) })).build();
  return { host, live: createMirage(host, 'store'), rows };
}

describe.each([{ pk: 'id' }, { pk: 'code' }, { pk: ['domain', 'authority'] }] as const)('cache identity $pk', ({ pk }) => {
  test.each(values)('direct/index/iteration/bound selection agrees with Aggregate for %s', value => {
    const { host, live, rows } = fixture(pk, value);
    const key = typeof pk === 'string' ? String(value) : { authority: 'a', domain: String(value) };
    const direct = Reflect.apply(live.rows, undefined, [key]);
    const selected = [direct, live.rows[0], [...live.rows][0], live.chosen()];
    for (const row of selected) expect(row.qty).toBe(1);
    const identity = typeof pk === 'string' ? { [pk]: String(value) } : key;
    const command = host.commandCreators.rowsAdd({ ...identity, qty: 2 });
    const events = host.process(host.initialState, command);
    const native = events.reduce((state, event) => host.apply(state, event), host.initialState);
    direct.add({ qty: 2 });
    expect(extractState(live)).toEqual(native);
    for (const row of selected) expect(row.qty).toBe(3);
    expect(live[MirageCoreSymbol].getPendingResults().events).toHaveLength(1);
    expect(extractState(live).rows[0]!.id).toBe(value);
    expect(rows[0]!.qty).toBe(1);
  });
});

test('adjacent large bigint identities remain distinct and stale live selections fail after replacement/removal', () => {
  const { live, rows } = fixture('id', 9007199254740992n);
  const first = live.rows('9007199254740992');
  live.replace({ rows: [rows[0]!, { ...rows[1]!, id: 9007199254740993n }] });
  const second = live.rows('9007199254740993');
  second.add({ qty: 5 });
  expect(first.qty).toBe(1);
  expect(second.qty).toBe(15);
  live.replace({ rows: [{ ...rows[0]!, id: 'replacement' }] });
  expect(() => first.qty).toThrow(/not found/i);
  expect(() => second.qty).toThrow(/not found/i);
  expect(live.rows('replacement').qty).toBe(1);
  live.replace({ rows: [] });
  expect(() => live.rows('replacement')).toThrow(/not found/i);
});

test('canonical composite fields preserve boundaries, schema separation, frozen input and version invalidation', () => {
  const first = Object.freeze({ domain: 'a,b', authority: 'c', id: 0n });
  const second = Object.freeze({ domain: 'a', authority: 'b,c', id: 1n });
  const rows = [first, second];
  const select = (entityPk: Record<string, Scalar>, version = 0) =>
    findEntityInCollection(rows, { entityPk, idsPayload: {}, packPrefix: [] }, version);
  expect(select({ authority: 'c', domain: 'a,b' })).toBe(first);
  expect(select({ domain: 'a', authority: 'b,c' })).toBe(second);
  expect(select({ id: '0' })).toBe(first);
  rows.reverse();
  expect(select({ id: 0 }, 1)).toBe(first);
  expect(select({ authority: 'b,c', domain: 'a' }, 1)).toBe(second);
  expect(Object.isFrozen(first)).toBe(true);
});

test('duplicate scalar-equivalent identities still reject native commands; cache retains last-winner reads', () => {
  const { host, live, rows } = fixture('id', 0);
  live.replace({ rows: [rows[0]!, { ...rows[1]!, id: '0' }] });
  expect(live.rows(0).qty).toBe(10);
  expect(() => live.rows(0).add({ qty: 1 })).toThrow(/invalid mounted command target/i);
  const state = { rows: [{ ...rows[0]! }, { ...rows[1]!, id: '0' }] };
  expect(() => host.process(state, host.commandCreators.rowsAdd({ id: 0, qty: 1 }))).toThrow(/invalid mounted command target/i);
  expect(live[MirageCoreSymbol].getPendingResults().events).toHaveLength(1);
});

test.each([false, {}, undefined, NaN, Infinity])('invalid lookup identity %s keeps existing guards', identity => {
  const { live } = fixture('id', 0);
  expect(() => Reflect.apply(live.rows, undefined, [identity])).toThrow(/invalid primary key/i);
});
