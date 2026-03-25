import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createEntity } from '../src/createEntity';
import { createMixin } from '../src/createMixin';
import { createMirage } from '../src/createMirage';
import { Event } from '../src/types';

type ParentState = { id: string; count: number; line: { id: string; qty: number }[] };

const initial: ParentState = { id: 'o1', count: 0, line: [{ id: 'l1', qty: 1 }] };

describe('createAggregate API coverage', () => {
  test('extends inherits parent commands/events', () => {
    const parent = createAggregate<ParentState, 'order'>('order', initial)
      .events({ incremented: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
      .commands((emit) => ({ increment: (state, amount: number) => emit.incremented({ amount }) }));

    const child = createAggregate<ParentState, 'order'>('order', initial)
      .extends(parent)
      .build();

    const evs = child.process(initial, { type: 'order.increment.command', payload: 2 });
    expect(evs[0].type).toBe('order.incremented.event');
    expect(child.commandCreators.increment(2).type).toBe('order.increment.command');
  });

  test('hooks run during mirage dispatch lifecycle', () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    let appliedCalls = 0;

    const onBeforeCommand = () => { beforeCalls += 1; };
    const onAfterCommand = () => { afterCalls += 1; };
    const onEventApplied = () => { appliedCalls += 1; };

    const builder = createAggregate<ParentState, 'order'>('order', initial)
      .events({ incremented: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
      .commands((emit) => ({ increment: (state, amount: number) => emit.incremented({ amount }) }))
      .hooks({ onBeforeCommand, onAfterCommand, onEventApplied })
      .build();

    const mirage = createMirage(builder, 'o1');
    mirage.increment(3);

    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(appliedCalls).toBe(1);
  });

  test('entityList(name, package) registers list entity component commands', () => {
    const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
      .events({ lineUpdated: (state, event: Event<{ qty: number }>) => { state.qty = event.payload.qty; } })
      .commands((emit) => ({ update: (state, payload: { id: string; qty: number }) => emit.lineUpdated(payload) }))
      .build();

    const aggregate = createAggregate<ParentState, 'order'>('order', initial)
        .entityList('line', lineEntity)
      .events({
        updated: (state: any, event: any) => { state.qty = event.payload.qty; }
      })
      .commands((emit) => ({}))
      .build();

    const command = aggregate.commandCreators.lineUpdate({ id: 'l1', qty: 9 });
    expect(command.type).toBe('order.lineUpdate.command');

    const events = aggregate.process(initial, command as any);
    expect(events[0].type).toBe('order.line.line_updated.event');
    const next = aggregate.apply(initial, events[0]);
    expect(next.line[0].qty).toBe(9);
  });

  test('entityList mount overrides allow reusing one entity package across paths', () => {
    type State = {
      id: string;
      orderLines: { id: string; qty: number }[];
      returnLines: { id: string; qty: number }[];
    };

    const state: State = {
      id: 'o1',
      orderLines: [{ id: 'ol1', qty: 1 }],
      returnLines: [{ id: 'rl1', qty: 2 }]
    };

    const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
      .events({ qtyUpdated: (line, event: Event<{ qty: number }>) => { line.qty = event.payload.qty; } })
      .overrideEventNames({})
      .selectors({})
      .commands((emit) => ({ update: (line, payload: { id: string; qty: number }) => emit.qtyUpdated(payload) }))
      .overrideCommandNames({})
      .build();

    const aggregate = createAggregate<State, 'order'>('order', state)
        .entityList('orderLines', lineEntity, undefined, {
        eventNameOverrides: { qtyUpdated: 'order.order_lines.qty_updated.event' },
        commandNameOverrides: { update: 'order.order_lines.update_qty.command' }
      })
        .entityList('returnLines', lineEntity, undefined, {
        eventNameOverrides: { qtyUpdated: 'order.return_lines.qty_updated.event' },
        commandNameOverrides: { update: 'order.return_lines.update_qty.command' }
      })
      .events({})
      .commands(() => ({}))
      .build();

    const orderCmd = aggregate.commandCreators.orderLinesUpdate({ id: 'ol1', qty: 5 });
    const returnCmd = aggregate.commandCreators.returnLinesUpdate({ id: 'rl1', qty: 7 });

    expect(orderCmd.type).toBe('order.order_lines.update_qty.command');
    expect(returnCmd.type).toBe('order.return_lines.update_qty.command');

    const orderEvents = aggregate.process(state, orderCmd as any);
    const returnEvents = aggregate.process(state, returnCmd as any);

    expect(orderEvents[0].type).toBe('order.order_lines.qty_updated.event');
    expect(returnEvents[0].type).toBe('order.return_lines.qty_updated.event');

    const afterOrder = aggregate.apply(state, orderEvents[0]);
    const afterReturn = aggregate.apply(afterOrder, returnEvents[0]);
    expect(afterReturn.orderLines[0].qty).toBe(5);
    expect(afterReturn.returnLines[0].qty).toBe(7);
  });

  test('projectors are scoped by mount path when event keys are shared', () => {
    type OrderLine = { id: string; qty: number };
    type ReturnLine = { id: string; status: string };
    type State = { id: string; orderLines: OrderLine[]; returnLines: ReturnLine[] };

    const state: State = {
      id: 'o1',
      orderLines: [{ id: 'ol1', qty: 1 }],
      returnLines: [{ id: 'rl1', status: 'OPEN' }]
    };

    const orderLineEntity = createEntity<OrderLine, 'line'>('line')
      .events({
        updated: (line, event: Event<{ qty: number }>) => {
          line.qty = event.payload.qty;
        }
      })
      .commands((emit) => ({
        update: (line, payload: { id: string; qty: number }) => emit.updated(payload)
      }))
      .build();

    const returnLineEntity = createEntity<ReturnLine, 'line'>('line')
      .events({
        updated: (line, event: Event<{ status: string }>) => {
          line.status = event.payload.status;
        }
      })
      .commands((emit) => ({
        update: (line, payload: { id: string; status: string }) => emit.updated(payload)
      }))
      .build();

    const aggregate = createAggregate<State, 'order'>('order', state)
        .entityList('orderLines', orderLineEntity)
        .entityList('returnLines', returnLineEntity)
      .events({})
      .commands(() => ({}))
      .build();

    const orderEvents = aggregate.process(state, aggregate.commandCreators.orderLinesUpdate({ id: 'ol1', qty: 5 }) as any);
    const returnEvents = aggregate.process(state, aggregate.commandCreators.returnLinesUpdate({ id: 'rl1', status: 'APPROVED' }) as any);

    const afterOrder = aggregate.apply(state, orderEvents[0]);
    const afterReturn = aggregate.apply(afterOrder, returnEvents[0]);

    expect(afterReturn.orderLines[0].qty).toBe(5);
    expect(afterReturn.returnLines[0].status).toBe('APPROVED');
  });

  test('mixins support entityList/entityMap/valueObjectList/valueObjectMap mounts', () => {
    type State = {
      id: string;
      orderLines: { id: string; qty: number }[];
      byCode: Record<string, { id: string; qty: number }>;
      aliases: { label: string }[];
      tagsByScope: Record<string, { label: string }>;
    };

    const state: State = {
      id: 'o1',
      orderLines: [{ id: 'ol1', qty: 1 }],
      byCode: { A: { id: 'a1', qty: 2 } },
      aliases: [{ label: 'home' }],
      tagsByScope: { US: { label: 'primary' } }
    };

    const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
      .events({ qtyChanged: (line, event: Event<{ id: string; qty: number }>) => { line.qty = event.payload.qty; } })
      .commands((emit) => ({
        changeQty: {
          pack: (id: string, qty: number) => ({ id, qty }),
          handler: (line, payload) => emit.qtyChanged(payload)
        }
      }))
      .build();

    const mixin = createMixin<State>()
      .entityList('orderLines', lineEntity)
      .entityMap('byCode', lineEntity, { knownKeys: ['A'] as const })
      .valueObjectList('aliases', {})
      .valueObjectMap('tagsByScope', {})
      .events({})
      .commands(() => ({}))
      .build();

    const aggregate = createAggregate<State, 'order'>('order', state)
      .mixins(mixin)
      .events({})
      .commands(() => ({}))
      .build();

    const live = createMirage(aggregate, 'o1');
    live.orderLines('ol1').changeQty(9);

    expect(live.orderLines[0].qty).toBe(9);
    expect(live.aliases[0].label).toBe('home');
    expect(live.tagsByScope.US.label).toBe('primary');
  });
});
