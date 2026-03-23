import { id } from 'zod/locales';
import { createAggregate } from '../src/createAggregate';
import { Event } from '../src/types';
import { createMixin } from '../src/createMixin';

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
};

describe('Domain Exmaple', () => {
  it('should create an aggregate with mixins and process commands', () => {
    const identifiers = createMixin<IdentifiersMixinState>()
      .events({
        identifierRegisterd: (state, event: Event<Identifier>) => {
          state.identifiers.push(event.payload);
        }
      }).commands((emit) => ({
        registerIdentifier: (state, domain: string, authority: string, identifier: string) => emit.identifierRegisterd({ domain, authority, identifier })
      })).build();

    const orderAggregateDef = createAggregate<OrderState&IdentifiersMixinState, 'order'>('order', { id: 'o1', orderLines: [], identifiers: [] })
      // .mixins(identifiers)
      .events({
        registered: (state, event: Event<OrderState>) => {
          Object.assign(state, event.payload);
        },
        cancelled: (state, event: Event<string>) => { state.isCancelled = true; state.cancelRemark = event.payload; }
      }).commands((emit) => ({
        register: (state, order: OrderState) => emit.registered(order),
        cancel: (state, remark: string) => emit.cancelled(remark)
      })).build();
  });
});
