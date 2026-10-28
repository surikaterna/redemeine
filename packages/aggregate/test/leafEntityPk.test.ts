import { createAggregate, createEntity } from '../src';
import type { Event } from '@redemeine/kernel';
import { produce } from 'immer';

type Item = { id: string | number; domain: string; qty: number };

function nestedHost(composite: boolean, id: string | number = 'c') {
  const called = jest.fn();
  const child = createEntity<Item, 'child'>('child')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) {
      called();
      return emit.changed({ ...payload, qty: state.qty + 1 });
    } })).build();
  const children = [{ id, domain: 'leaf', qty: 2 }, { id: 'sibling', domain: 'leaf', qty: 20 }];
  const parent = createEntity<{ id: string; domain: string; children: Item[] }, 'parent'>('parent')
    .entityList('children', child, composite ? { pk: ['id', 'domain'] } : {}).build();
  const state = { qty: 99, parents: [
    { id: 'other', domain: 'ancestor', children: structuredClone(children) },
    { id: 'p', domain: 'ancestor', children }
  ] };
  const host = createAggregate('store', state)
    .entityList('parents', parent, composite ? { pk: ['id', 'domain'] } : {}).build();
  return { host, called };
}

test.each([false, true])('authored __entityPk is ordinary business data (composite=%s)', composite => {
  const { host } = nestedHost(composite);
  const ancestor = { parentsId: 'p', ...(composite ? { parentsDomain: 'ancestor' } : {}) };
  const identity = { id: 'c', ...(composite ? { domain: 'leaf' } : {}) };
  for (const canonical of [false, true]) {
    const payload = { ...ancestor, ...(canonical ? identity : {}), __entityPk: { id: 'wrong' }, qty: 2 };
    if (!canonical) {
      expect(() => host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload))).toThrow('Invalid mounted command target');
      continue;
    }
    const before = structuredClone(payload);
    const event = host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload))[0]!;
    expect(event.payload).toEqual({ ...payload, qty: 3 });
    const expected = structuredClone(host.initialState);
    expected.parents[1]!.children[0]!.qty = 3;
    expect(host.apply(host.initialState, event)).toEqual(expected);
    expect(produce(host.initialState, draft => host.applyToDraft(draft, event))).toEqual(expected);
    expect(payload).toEqual(before);
  }
});

test.each([0, ''])('canonical leaf retains falsy identity %j', id => {
  const { host } = nestedHost(false, id);
  const event = host.process(host.initialState, host.commandCreators.parentsChildrenSet({ parentsId: 'p', id }))[0]!;
  expect(host.apply(host.initialState, event).parents[1]!.children[0]!.qty).toBe(3);
  expect(produce(host.initialState, draft => host.applyToDraft(draft, event))).toEqual(host.apply(host.initialState, event));
});

test.each([
  { parentsId: 'p', __entityPk: { id: 'c' } },
  { __entityPk: { id: 'c' } },
  { parentsId: 'missing', __entityPk: { id: 'c' } }
])('invalid ancestor or inconsistent leaf still rejects %j', payload => {
  const { host, called } = nestedHost(false);
  const before = structuredClone(host.initialState);
  expect(() => host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload))).toThrow('Invalid mounted command target');
  expect(called).not.toHaveBeenCalled();
  expect(host.initialState).toEqual(before);
});
