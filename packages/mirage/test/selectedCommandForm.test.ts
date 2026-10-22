import { createAggregate, createEntity } from '../../aggregate/src';
import type { Event } from '@redemeine/kernel';
import { createMirage, extractState } from '../src';

const row = createEntity<{ id: string; qty: number }, 'row'>('row')
  .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
  .commands(emit => ({
    set(state, payload: { id: string; qty: number }) {
      if (typeof payload.qty !== 'number') throw new TypeError('qty required');
      expect(() => Reflect.set(state, 'qty', 100)).toThrow();
      return emit.changed({ id: payload.id, qty: state.qty + payload.qty });
    },
    setObject: { handler: (state: Readonly<{ qty: number }>, payload: { id: string; qty: number }) => emit.changed({ ...payload, qty: state.qty + payload.qty }), meta: { label: 'set' } },
    setQuantity: { pack: (id: string, qty: number) => ({ id, qty }),
      handler: (state, payload: { id: string; qty: number }) => emit.changed({ ...payload, qty: state.qty + payload.qty }) }
  })).build();
const host = createAggregate('store', { rows: [{ id: 'a', qty: 1 }, { id: 'b', qty: 10 }] })
  .entityList('rows', row).build();

test('single object payload and packed commands use the readonly selected state', () => {
  const live = createMirage(host, 'store');
  // Reflect invocation reproduces the current missing-quantity failure without bypassing TS with casts.
  expect(() => Reflect.apply(live.rows('a').set, undefined, [])).toThrow('qty required');
  Reflect.apply(live.rows('a').set, undefined, [{ qty: 2 }]);
  Reflect.apply(live.rows[0]!.setObject, undefined, [{ qty: 3 }]);
  live.rows('a').setQuantity(4);
  expect(extractState(live).rows).toEqual([{ id: 'a', qty: 10 }, { id: 'b', qty: 10 }]);
});

test('selected identity rejects conflicting caller identity rather than retargeting', () => {
  const live = createMirage(host, 'store');
  expect(() => Reflect.apply(live.rows('a').setObject, undefined, [{ id: 'b', qty: 2 }])).toThrow(/identity/i);
  expect(extractState(live).rows[1]!.qty).toBe(10);
});
