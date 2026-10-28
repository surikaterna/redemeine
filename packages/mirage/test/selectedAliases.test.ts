import { createAggregate, createEntity } from '../../aggregate/src';
import { createMirage, extractState, MirageCoreSymbol } from '../src';

function fixture(composite: boolean) {
  const handler = jest.fn();
  const before = jest.fn();
  const item = createEntity<{ code: string; domain: string; authority: string; qty: number }, 'item'>('item')
    .events({ changed(state, event: { payload: { qty: number } }) { state.qty = event.payload.qty; } })
    .commands(emit => ({
      packed: { pack: (first: string, second: string | { qty: number; itemsCode?: unknown; itemsDomain?: unknown }, body?: { qty: number }) =>
        composite ? { domain: first, authority: second, ...body } : { code: first, ...(typeof second === 'object' ? second : {}) },
      handler: (state, payload: { qty?: number }) => { handler(); return emit.changed({ ...payload, qty: state.qty + (payload.qty ?? 0) }); } },
      alias: { pack: (first: string, second: string | number, qty?: number) => composite
        ? { itemsDomain: first, itemAuthority: second, qty } : { itemsId: first, qty: second },
      handler: (state, payload: { qty?: number | string }) => { handler(); return emit.changed({ ...payload, qty: state.qty + Number(payload.qty) }); } }
    })).build();
  const host = createAggregate('store', { items: [{ code: 'a', domain: 'a', authority: '', qty: 1 }] })
    .entityList('items', item, { pk: composite ? ['domain', 'authority'] as const : 'code' })
    .selectors(({ bindContext }) => ({ selected: state => bindContext(state.items, item) })).build();
  host.hooks = { onBeforeCommand: before };
  const live = createMirage(host, 'store');
  return { live, handler, before };
}

test.each([false, true])('canonical identities checked before dispatch (composite=%s)', composite => {
  const { live, handler, before } = fixture(composite);
  const state = extractState(live);
  const pending = live[MirageCoreSymbol].getPendingResults();
  const direct = live.items(composite ? { domain: 'a', authority: '' } : 'a');
  for (const selected of [direct, live.items[0]!, [...live.items][0]!, live.selected()[0]!]) {
    for (const value of ['b', undefined, false]) {
      expect(() => selected.packed({ qty: 2, [composite ? 'domain' : 'code']: value })).toThrow(/identity/i);
    }
  }
  expect(before).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(extractState(live)).toEqual(state);
  expect(live[MirageCoreSymbol].getPendingResults()).toEqual(pending);
});

test('former aliases are ordinary business fields regardless of mount spelling', () => {
  const before = jest.fn();
  const item = createEntity<{ code: number; qty: number }, 'item'>('item').events({})
    .commands(() => ({ packed: {
      pack: (code: number, body: { order_itemsCode: unknown; orderItemCode?: unknown; qty: number }) => ({ code, ...body }),
      handler: () => []
    } })).build();
  const host = createAggregate('store', { order_items: [{ code: 0, qty: 1 }] })
    .entityList('order_items', item, { pk: 'code' }).build();
  host.hooks = { onBeforeCommand: before };
  const selected = createMirage(host, 'store').order_items(0);
  selected.packed({ order_itemsCode: 0n, orderItemCode: false, qty: 2 });
  expect(before).toHaveBeenCalledTimes(1);
  selected.packed({ order_itemsCode: 0n, orderItemCode: '0', qty: 2 });
  expect(before).toHaveBeenCalledTimes(2);
});

test.each([false, true])('retired alias-only pack rejected before hooks (composite=%s)', composite => {
  const { live, before, handler } = fixture(composite);
  expect(() => live.items[0]!.alias(2)).toThrow(/identity/i);
  expect(live.items[0]!.qty).toBe(1);
  expect(before).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
