import { describe, expect, test } from '@jest/globals';
import { createEntity } from '../src/createEntity';

describe('createEntity', () => {
  test('builds entity package with flat builder API and metadata', () => {
    const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
      .events({
        qtyUpdated: (state, event: any) => {
          state.qty = event.payload.qty;
        }
      })
      .overrideEventNames({ qtyUpdated: 'legacy.line.qty_updated.event' })
      .selectors({ isPositive: (state) => state.qty > 0 })
      .commands((emit, ctx) => ({
        updateQty: (state, qty: number) => {
          if (!ctx.selectors.isPositive({ ...state, qty } as any) && qty <= 0) {
            throw new Error('invalid qty');
          }
          return emit.qtyUpdated({ qty });
        }
      }))
      .overrideCommandNames({ updateQty: 'legacy.line.update_qty.command' })
      .build();

    expect(lineEntity.name).toBe('line');
    expect(lineEntity.eventOverrides).toEqual({ qtyUpdated: 'legacy.line.qty_updated.event' });
    expect(lineEntity.commandOverrides).toEqual({ updateQty: 'legacy.line.update_qty.command' });
    expect(typeof lineEntity.commandFactory).toBe('function');
  });

  test('creates executable commands from commandFactory', () => {
    const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
      .events({
        qtyUpdated: (state, event: any) => {
          state.qty = event.payload.qty;
        }
      })
      .overrideEventNames({})
      .selectors({})
      .commands((emit) => ({
        updateQty: (state, qty: number) => emit.qtyUpdated({ qty })
      }))
      .overrideCommandNames({})
      .build();

    const fakeEmit = {
      qtyUpdated: (payload: any) => ({ type: 'order.line.qtyUpdated.event', payload })
    };
    const cmds = lineEntity.commandFactory(fakeEmit, { selectors: {} });
    const updateQty = (cmds.updateQty as (state: { id: string; qty: number }, qty: number) => any);
    const event = updateQty({ id: 'l1', qty: 1 }, 5);

    expect(event).toEqual({ type: 'order.line.qtyUpdated.event', payload: { qty: 5 } });
  });
});
