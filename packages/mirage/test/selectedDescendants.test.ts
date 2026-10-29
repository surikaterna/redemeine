import type { Event } from '@redemeine/kernel';
import { commandMetadata, createAggregate, createEntity } from '../../aggregate/src';
import { createMirage, extractState } from '../src';

type Child = { id: string; qty: number };
type Parent = { id: string; qty: number; children: Child[] };
const child = createEntity<Child, 'child'>('child')
  .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
  .commands(emit => ({ read: (state, payload: Record<string, unknown>) => emit.changed({ ...payload, qty: state.qty + 1 }) })).build();
const parent = createEntity<Parent, 'parent'>('parent').entityList('children', child)
  .events({ touched(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
  .commands(emit => ({ touch: (state, payload: Record<string, unknown>) => emit.touched({ ...payload, qty: state.qty + 1 }) })).build();
const later = createEntity<Parent, 'later'>('later').commands(() => ({ other: () => [] })).build();
const row = (): Parent => ({ id: 'p', qty: 0, children: [{ id: 'c', qty: 10 }] });

test.each([false, true])('selected parent hides descendants with earlier role=%s', earlier => {
  const base = createAggregate('store', { parents: [row()], others: [row()] }).entityList('parents', parent);
  const host = (earlier ? base.entityList('others', later) : base)
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.parents[0], parent, { mount: 'parents' }) })).build();
  const live = createMirage(host, 'store');
  const views = [live.parents('p'), live.parents[0]!, [...live.parents][0]!, live.chosen()!];
  for (const view of views) {
    expect(Reflect.get(view, 'childrenRead')).toBeUndefined();
    expect(typeof view.touch).toBe('function');
    view.touch({});
    expect(() => Reflect.set(view.children[0]!, 'qty', 99)).toThrow('Cannot mutate');
  }
  expect(Reflect.get(live.chosen()!, 'other')).toBeUndefined();
  expect(extractState(live).parents[0]!.qty).toBe(4);
  const command = host.commandCreators.parentsChildrenRead({ parentsId: 'p', id: 'c' });
  const events = host.process(host.initialState, command);
  expect(events.reduce((state, event) => host.apply(state, event), host.initialState).parents[0]!.children[0]!.qty).toBe(11);
});

test('map entry and iteration omit descendant methods but retain parent commands', () => {
  const host = createAggregate('store', { parents: { p: row() } }).entityMap('parents', parent).build();
  const live = createMirage(host, 'store');
  for (const view of [live.parents.p!, [...live.parents][0]!]) {
    expect(Reflect.get(view, 'childrenRead')).toBeUndefined();
    view.touch({});
  }
  expect(extractState(live).parents.p.qty).toBe(2);
});

test('a direct command named childrenRead is not classified by its spelling', () => {
  const direct = createEntity<Parent, 'direct'>('direct').commands(() => ({ childrenRead: () => [] })).build();
  const host = createAggregate('store', { parents: [row()] }).entityList('parents', direct).build();
  expect(typeof createMirage(host, 'store').parents('p').childrenRead).toBe('function');
});

test('a shadowed descendant does not prevent binding a valid earlier parent role', () => {
  const host = createAggregate('store', { parents: [row()], others: [{ id: 'c', qty: 10 }] })
    .entityList('parents', parent, undefined, { commandNameOverrides: { childrenRead: 'shared.read.command' } })
    .entityList('others', child, undefined, { commandNameOverrides: { read: 'shared.read.command' } })
    .entityList('unrelated', later)
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.parents[0], parent, { mount: 'parents' }) })).build();
  expect(commandMetadata(host, 'parentsChildrenRead')!.isWireWinner).toBe(false);
  const live = createMirage(host, 'store');
  expect(Reflect.get(live.chosen()!, 'childrenRead')).toBeUndefined();
  live.chosen()!.touch({});
  expect(extractState(live).parents[0]!.qty).toBe(1);
});
