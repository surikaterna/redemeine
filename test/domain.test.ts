import { createAggregate } from '../src/createAggregate';
import { Event } from '../src/types';
import { createMixin } from '../src/createMixin';
import { createEntity } from '../src/createEntity';
import { createMirage } from '../src/createMirage';

interface OrderLine {
  id: string;
  qty: number;
  subOrderLine: OrderLine[];
}

interface Identifier {
  domain: string;
  authority: string;
  identifier: string;
}

type Identifiers = Identifier[];

type IdentifiersMixinState = {
  identifiers: Identifiers;
};

interface OrderState {
  id: string;
  orderLines: OrderLine[];
  isCancelled?: boolean;
  cancelRemark?: string;
}

describe('Domain Exmaple', () => {
  it('should create an aggregate with mixins and process commands', async () => {
    const identifiers = createMixin<IdentifiersMixinState>()
      .events({
        identifierRegisterd: (state, event: Event<Identifier>) => {
          state.identifiers.push(event.payload);
        }
      })
      .commands((emit) => ({
        registerIdentifier: (state, domain: string, authority: string, identifier: string) => emit.identifierRegisterd({ domain, authority, identifier })
      }))
      .build();

    const orderLineEntity = createEntity<OrderLine, 'orderLine'>('orderLine')
      .events({
        qtyChanged: (state, event: Event<{ qty: number }>) => {
          state.qty = event.payload.qty;
        },
        deregistered: (state, event: Event<{ id: string; reason: string }>) => {}
      })
      .commands((emit) => ({
        changeQty: {
          pack: (orderLineId: string, qty: number) => ({ orderLineId, qty }),
          handler: (state, payload) => emit.qtyChanged(payload)
        },
        deregister: (state, reason: string) => emit.deregistered({ id: state.id, reason })
      }))
      .build();

    const orderAggregateDef = createAggregate<OrderState & IdentifiersMixinState, 'order'>('order', {
      id: 'o1',
      orderLines: [{ id: 'l1', qty: 1, subOrderLine: [] }],
      identifiers: []
    })
      .mixins(identifiers)
      .entityList('orderLines', orderLineEntity)
      .selectors({
        getIdentifier: (state, domain: string) => state.identifiers.find((id) => id.domain === domain),
        findOrderLinesDeep: (state, predicate: (line: OrderLine) => boolean) => state.orderLines.filter(predicate)
      })
      .events({
        registered: (state, event: Event<OrderState>) => {
          Object.assign(state, event.payload);
        },
        cancelled: (state, event: Event<string>) => {
          state.isCancelled = true;
          state.cancelRemark = event.payload;
        }
      })
      .commands((emit) => ({
        register: (state, order: OrderState) => emit.registered(order),
        cancel: (state, remark: string) => emit.cancelled(remark)
      }))
      .build();

    const cmd = orderAggregateDef.commandCreators.orderLinesChangeQty('l1', 5);
    const events = orderAggregateDef.process(orderAggregateDef.initialState, cmd as any);
    const nextState = orderAggregateDef.apply(orderAggregateDef.initialState, events[0]);

    expect(events[0].type).toBe('order.order_lines.qty_changed.event');
    expect(nextState.orderLines[0].qty).toBe(5);
    const order = createMirage(orderAggregateDef, 'order-1', { events });
    await order.orderLines('l1').changeQty(10);

    const deepLines = order.findOrderLinesDeep((line) => line.id === 'l1');
    expect(deepLines.length).toBe(1);
    const firstLine = deepLines.first();
    expect(firstLine).toBeDefined();
    await firstLine!.changeQty(11);
    expect(order.orderLines[0].qty).toBe(11);



    const orderWithIdentifier = createMirage(orderAggregateDef, 'order-2', {
      snapshot: {
        ...orderAggregateDef.initialState,
        identifiers: [{ domain: 'tax', authority: 'irs', identifier: 'A-1' }]
      }
    });
    expect(orderWithIdentifier.getIdentifier('tax')?.identifier).toBe('A-1');
  });
});
