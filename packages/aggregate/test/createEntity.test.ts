import { describe, expect, test } from '@jest/globals';
import { createEntity } from '@redemeine/aggregate';
import { Event } from '@redemeine/kernel';

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

  test('supports nested entity/valueObject mount APIs on createEntity', () => {
    const subLineEntity = createEntity<{ id: string; qty: number }, 'subLine'>('subLine')
      .events({ qtyUpdated: (state, event: Event<{ qty: number }>) => { state.qty = event.payload.qty; } })
      .commands((emit) => ({ update: (state, payload: { id: string; qty: number }) => emit.qtyUpdated(payload) }))
      .build();

    const lineEntity = createEntity<{ id: string; qty: number; subLines: { id: string; qty: number }[]; byCode: Record<string, { id: string; qty: number }>; aliases: { label: string }[]; tagsByScope: Record<string, { label: string }> }, 'line'>('line')
      .entityList('subLines', subLineEntity)
      .entityMap('byCode', subLineEntity, { knownKeys: ['A', 'B'] as const })
      .valueObjectList('aliases', {})
      .valueObjectMap('tagsByScope', {})
      .events({})
      .commands(() => ({}))
      .build();

    expect(lineEntity.mounts.subLines.kind).toBe('list');
    expect(lineEntity.mounts.byCode.kind).toBe('map');
    expect(lineEntity.mounts.aliases.kind).toBe('valueObjectList');
    expect(lineEntity.mounts.tagsByScope.kind).toBe('valueObjectMap');

    const fakeEmit = {
      subLinesQtyUpdated: (payload: any) => ({ type: 'order.line.sub_lines.qty_updated.event', payload }),
      byCodeQtyUpdated: (payload: any) => ({ type: 'order.line.by_code.qty_updated.event', payload })
    };

    const cmds = lineEntity.commandFactory(fakeEmit, { selectors: {} });
    expect(typeof (cmds as any).subLinesUpdate).toBe('function');
    expect(typeof (cmds as any).byCodeUpdate).toBe('function');

    const subLinesEvent = (cmds as any).subLinesUpdate({ id: 's1', qty: 1 }, { id: 's1', qty: 9 });
    const byCodeEvent = (cmds as any).byCodeUpdate({ id: 'a1', qty: 2 }, { id: 'a1', qty: 7 });

    expect(subLinesEvent).toEqual({ type: 'order.line.sub_lines.qty_updated.event', payload: { id: 's1', qty: 9 } });
    expect(byCodeEvent).toEqual({ type: 'order.line.by_code.qty_updated.event', payload: { id: 'a1', qty: 7 } });
  });
});
