import { createAggregate, createEntity } from '../../aggregate/src';
import { createMirage, extractState, MirageCoreSymbol } from '../src';

function fixture(kind: 'list' | 'map' | 'composite') {
  const handler = jest.fn();
  const before = jest.fn();
  const item = createEntity<{ qty: number }, 'item'>('item')
    .events({ changed(state, event: { payload: { qty: number } }) { state.qty = event.payload.qty; } })
    .commands(emit => ({
      packed: { pack: (id: string | number, second: unknown, third?: unknown) =>
        Object.assign(kind === 'map' ? { key: id } : kind === 'composite' ? { domain: id, authority: second } : { id }, kind === 'composite' ? third : second),
      handler: (state, payload: { qty: number }) => { handler(); return emit.changed({ ...payload, qty: state.qty + payload.qty }); } },
      missing: { pack: () => ({ qty: 2 }), handler: () => { handler(); } },
      primitive: { pack: () => 2, handler: () => { handler(); } },
      set: (state, payload: { qty: number }) => { handler(); return emit.changed({ ...payload, qty: state.qty + payload.qty }); }
    })).build();
  const initial = [{ id: 0, domain: 0, authority: '', qty: 1 }, { id: 'b', domain: 'b', authority: '', qty: 20 }];
  const builder = createAggregate('store', { items: initial, entries: { '0': { qty: 1 }, b: { qty: 20 } } });
  const host = kind === 'map' ? builder.entityMap('entries', item).build() :
    kind === 'composite' ? builder.entityList('items', item, { pk: ['domain', 'authority'] }).build() : builder.entityList('items', item).build();
  host.hooks = { onBeforeCommand: before };
  const live = createMirage(host, 'store');
  const selected = kind === 'map' ? live.entries['0'] : kind === 'composite' ? live.items({ domain: 0, authority: '' }) : live.items(0);
  return { live, selected, handler, before };
}

test.each(['list', 'map', 'composite'] as const)('%s final packed target cannot escape selection or omit identity', kind => {
  const { live, selected, handler, before } = fixture(kind);
  const state = extractState(live);
  const events = live[MirageCoreSymbol].getPendingResults();
  const field = kind === 'map' ? 'key' : kind === 'composite' ? 'domain' : 'id';
  for (const body of [{ [field]: 'b', qty: 2 }, { [field]: undefined, qty: 2 }, { [field]: false, qty: 2 }]) {
    expect(() => Reflect.apply(selected.packed, undefined, [body])).toThrow(/identity/i);
  }
  expect(() => selected.missing()).toThrow(/identity/i);
  expect(() => selected.primitive()).toThrow();
  expect(before).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(extractState(live)).toEqual(state);
  expect(live[MirageCoreSymbol].getPendingResults()).toEqual(events);
});

test.each(['list', 'map', 'composite'] as const)('%s shorthand scalar aliases match native Aggregate', kind => {
  const { live, selected, handler, before } = fixture(kind);
  const field = kind === 'map' ? 'key' : kind === 'composite' ? 'domain' : 'id';
  Reflect.apply(selected.set, undefined, [{ [field]: kind === 'map' ? 0 : '0', qty: 2 }]);
  expect(selected.qty).toBe(3);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(before).toHaveBeenCalledTimes(1);
  expect(() => Reflect.apply(selected.set, undefined, [{ [field]: false, qty: 2 }])).toThrow(/identity/i);
  expect(live[MirageCoreSymbol].getPendingResults().events).toHaveLength(1);
});
