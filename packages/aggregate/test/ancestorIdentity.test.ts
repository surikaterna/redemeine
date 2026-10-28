import type { Event } from '@redemeine/kernel';
import { produce } from 'immer';
import { createAggregate, createEntity } from '../src';
import { selectedCommandState } from '../src/build/entityCommandTarget';
import type { EntityCommandTarget } from '../src/types/entityMount';

type Item = { id: string; code: string | number; region: string; authority: string; qty: number };
const item = (code: string | number, qty: number): Item => ({ id: String(code), code, region: code === 'c' ? 'r' : String(code), authority: 'a', qty });

function nestedHost(parentPk: string | string[], childPk: string | string[]) {
  const called = jest.fn();
  const child = createEntity<Item, 'child'>('child')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) {
      called();
      return emit.changed({ ...payload, qty: state.qty + 1 });
    } })).build();
  const children = [item('c', 2), item('sibling', 20), item(0, 4), item('', 6)];
  const parent = createEntity<Item & { children: Item[] }, 'parent'>('parent')
    .entityList('children', child, { pk: childPk }).build();
  const state = { qty: 99, parents: [
    { ...item('other', 80), children: structuredClone(children) },
    { ...item('p', 90), region: 'r', children }
  ] };
  const host = createAggregate('store', state).entityList('parents', parent, { pk: parentPk }).build();
  return { host, called };
}

function expectSelectedOnly(parentPk: string | string[], childPk: string | string[], payload: Record<string, unknown>, index = 0) {
  const { host, called } = nestedHost(parentPk, childPk);
  const before = structuredClone(host.initialState);
  const payloadBefore = structuredClone(payload);
  const expected = structuredClone(before);
  expected.parents[1]!.children[index]!.qty += 1;
  const event = host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload))[0]!;
  expect(called).toHaveBeenCalledTimes(1);
  expect(host.apply(host.initialState, event)).toEqual(expected);
  expect(produce(host.initialState, draft => host.applyToDraft(draft, event))).toEqual(expected);
  expect(host.initialState).toEqual(before);
  expect(payload).toEqual(payloadBefore);
}

test.each([
  ['code', 'code', { parentsCode: 'p', code: 'c' }],
  ['id', 'code', { parentsId: 'p', code: 'c' }],
  [['code', 'region'], ['code', 'authority'], { parentsCode: 'p', parentsRegion: 'r', code: 'c', authority: 'a' }],
  [['code', 'authority'], ['region', 'authority'], { parentsCode: 'p', parentsAuthority: 'a', region: 'r', authority: 'a' }],
  ['code', 'code', { parentsCode: 'p', code: 'c', parentCode: 'ordinary', childrenCode: 'ordinary', __entityPk: { code: 'ordinary' } }]
] as [string | string[], string | string[], Record<string, unknown>][])('qualified ancestors do not consume leaf fields: %j / %j / %j', expectSelectedOnly);

test.each([[0, 2], ['', 3]] as const)('preserves scalar leaf identity %j', (code, index) => {
  expectSelectedOnly('code', 'code', { parentsCode: 'p', code }, index);
});

test.each([
  ['code', 'code', { parentCode: 'p', code: 'c' }],
  ['code', 'code', { parentsCode: 'p', childrenCode: 'c' }],
  ['code', 'code', { parentsCode: 'p', __entityPk: { code: 'c' } }],
  ['code', 'code', { code: 'c' }],
  ['code', 'code', { __entityPk: { code: 'c' } }],
  ['code', 'code', { parentsCode: 'missing', code: 'c' }],
  [['code', 'region'], ['code', 'authority'], { parentsCode: 'p', region: 'r', code: 'c', authority: 'a' }],
  // Previously accepted unqualified ancestor code is intentionally rejected, even with a distinct leaf PK.
  ['code', 'id', { code: 'p', id: 'c' }]
] as [string | string[], string | string[], Record<string, unknown>][])('rejects missing or inconsistent qualified identities: %j / %j / %j', (parentPk, childPk, payload) => {
  const { host, called } = nestedHost(parentPk, childPk);
  const before = structuredClone(host.initialState);
  const payloadBefore = structuredClone(payload);
  const validEvent = host.process(host.initialState, host.commandCreators.parentsChildrenSet({
    parentsCode: 'p', parentsRegion: 'r', parentsAuthority: 'a', ...item('c', 2)
  }))[0]!;
  called.mockClear();
  const command = host.commandCreators.parentsChildrenSet(payload);
  expect(() => host.process(host.initialState, command)).toThrow('Invalid mounted command target');
  expect(called).not.toHaveBeenCalled();
  const event = { ...validEvent, payload: { ...payload, qty: 3 } };
  expect(() => host.apply(host.initialState, event)).toThrow('Invalid mounted command target');
  expect(() => produce(host.initialState, draft => host.applyToDraft(draft, event))).toThrow('Invalid mounted command target');
  expect(host.initialState).toEqual(before);
  expect(payload).toEqual(payloadBefore);
});

test('single list mount still accepts unqualified custom code', () => {
  const chain: EntityCommandTarget[] = [{ kind: 'list', statePath: ['children'], pk: 'code', commandPrefix: 'children' }];
  const child = item('c', 2);
  expect(selectedCommandState({ children: [child] }, { code: 'c' }, chain)).toBe(child);
});

test('three levels retain existing per-mount qualifiers and require every ancestor', () => {
  const chain: EntityCommandTarget[] = ['parents', 'groups', 'children'].map(name => ({
    kind: 'list', statePath: [name], pk: 'code', commandPrefix: name
  }));
  const child = item('c', 2);
  const state = { parents: [{ code: 'p', groups: [{ code: 'g', children: [child] }] }] };
  expect(selectedCommandState(state, { parentsCode: 'p', groupsCode: 'g', code: 'c' }, chain)).toBe(child);
  expect(() => selectedCommandState(state, { parentsCode: 'p', code: 'c' }, chain)).toThrow('Invalid mounted command target');
});
