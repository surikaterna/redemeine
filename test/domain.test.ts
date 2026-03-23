import { id } from 'zod/locales';
import { createAggregate } from '../src/createAggregate';

interface OrderLine {
  id: string;
  qty: number;
  subOrderLine: OrderLine[];
}

interface OrderState {
  id: string;
  orderLines: OrderLine[];
}
describe('Domain Exmaple', () => {
  it('should create an aggregate with mixins and process commands', () => {
    const aggregate = createAggregate<OrderState, 'order'>('order', { id: 'o1', orderLines: [] })
    .events({
        registered: (state, event:Event<OrderState>) => {
            Object.assign(state, event.payload);
    })
  });
});
