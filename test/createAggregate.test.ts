import { createAggregate } from '../src/createAggregate';
import { createMixin } from '../src/createMixin';
import { Event } from '../src/types';

// --- Setup Mock Data ---

interface TestState {
  id: string;
  status: string;
  count: number;
  items: string[];
}

const initialState: TestState = {
  id: '',
  status: 'open',
  count: 0,
  items: []
};

// --- Define a reusable Mixin ---

const counterMixin = createMixin<{ count: number }>()
  .events({
    incremented: (state, event: Event<{ amount: number }>) => {
      state.count += event.payload.amount;
    }
  })
  .overrideEventNames({
    incremented: 'legacy.counter.incremented.event'
  })
  .selectors({}).commands((emit, ctx) => ({
    increment: (state, amount: number) => emit.incremented({ amount })
  }))
  .overrideCommandNames({
    increment: 'legacy.counter.increment.command'
  })
  .build();

// --- The Test Suite ---

describe('Aggregate Builder with Mixins', () => {
  
  it('should process core commands and default naming strategy', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        opened: (state, event: Event<{ id: string }>) => {
          state.id = event.payload.id;
        }
      })
      .selectors({}).commands((emit, ctx) => ({
        open: (state, id: string) => emit.opened({ id })
      }))
      .build();

    // Test Command Creator Name
    const cmd = aggregate.commandCreators.open('123');
    expect(cmd.type).toBe('test.open.command');

    // Test Process -> Apply lifecycle
    const events = aggregate.process(initialState, { type: 'test.open.command', payload: '123' });
    expect(events[0].type).toBe('test.opened.event');

    const newState = aggregate.apply(initialState, events[0]);
    expect(newState.id).toBe('123');
  });

  it('should correctly merge mixin commands and events', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .mixins(counterMixin)
      .build();

    // 1. Check if mixin command exists on creators
    const cmd = aggregate.commandCreators.increment(5);
    expect(cmd.type).toBe('legacy.counter.increment.command');

    // 2. Check if process recognizes the overridden mixin command
    const events = aggregate.process(initialState, { type: 'legacy.counter.increment.command', payload: 5 });
    expect(events[0].type).toBe('legacy.counter.incremented.event');
    expect(events[0].payload).toEqual({ amount: 5 });

    // 3. Check if apply processes the mixin event
    const newState = aggregate.apply(initialState, events[0]);
    expect(newState.count).toBe(5);
  });

  it('should allow core overrides to take precedence or coexist', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        closed: (state) => { state.status = 'closed'; }
      })
      .selectors({}).commands((emit, ctx) => ({
        close: () => emit.closed()
      }))
      .overrideEventNames({
        closed: 'explicit.closed.event'
      })
      .overrideCommandNames({
        close: 'explicit.close.command'
      })
      .build();

    const cmd = aggregate.commandCreators.close();
    expect(cmd.type).toBe('explicit.close.command');

    const events = aggregate.process(initialState, { type: 'explicit.close.command', payload: undefined });
    expect(events[0].type).toBe('explicit.closed.event');
  });

it('should throw an error when processing an unknown command', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState).build();

    expect(() => {
      aggregate.process(initialState, { type: 'ghost.command', payload: {} });
    }).toThrow('Unknown command: ghost.command');
  });

  it('should maintain immutability using Immer', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        itemAdded: (state, event: Event<string>) => {
          state.items.push(event.payload);
        }
      })
      .build();

    const event = { type: 'test.itemAdded.event' as any, payload: 'first-item' };
    const newState = aggregate.apply(initialState, event);

    expect(initialState.items.length).toBe(0); // Original state untouched
    expect(newState.items.length).toBe(1);    // New state updated
    expect(newState.items[0]).toBe('first-item');
  });

  it('should support multiple mixins merged together', () => {
    const otherMixin = createMixin<TestState>()
      .events({ 
        statusChanged: (state, event: Event<string>) => { state.status = event.payload; } 
      })
      .overrideEventNames({}) // Empty overrides test
      .selectors({}).commands((emit, ctx) => ({
        changeStatus: (state, status: string) => emit.statusChanged(status)
      }))
      .overrideCommandNames({})
      .build();

    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .mixins(counterMixin, otherMixin)
      .build();

    // Can we call commands from both?
    const cmd1 = aggregate.commandCreators.increment(1);
    const cmd2 = aggregate.commandCreators.changeStatus('active');

    expect(cmd1.type).toBe('legacy.counter.increment.command');
    expect(cmd2.type).toBe('test.changeStatus.command');
  });

  it('should support entities, nested entities, arrays and targeted events', () => {
    interface SubOrderLine { id: number; metadata: string; }
    interface OrderLine { id: string; qty: number; subitems: SubOrderLine[]; }
    interface OrderState { id: string; line: OrderLine[]; }
    const orderState: OrderState = {
      id: 'o1',
      line: [{ id: '123', qty: 1, subitems: [{ id: 456, metadata: 'old' }] }]
    };

    const aggregate = createAggregate<OrderState, 'order'>('order', orderState)
      .entities<{ line: OrderLine; subitems: SubOrderLine }>()
      .events({
        updated: (state: any, event: Event<{ qty?: number; metadata?: string }>) => {
          if (event.payload.qty !== undefined) state.qty = event.payload.qty;
          if (event.payload.metadata !== undefined) state.metadata = event.payload.metadata;
        }
      })
      .selectors({}).commands((emit, ctx) => ({
        // Targeting line
        updateLine: (state, payload: { id: string; qty: number }) => 
          emit.lineUpdated({ lineId: payload.id, qty: payload.qty }),

        // Targeting subitems
        updateSubLine: (state, payload: { lineId: string; subId: number; metadata: string }) =>
          emit.lineSubitemsUpdated({ lineId: payload.lineId, subitemsId: payload.subId, metadata: payload.metadata })
      }))
      .build();

    // 1. Check generated event types
    // Using process to invoke command
    const events1 = aggregate.process(orderState, { type: 'order.updateLine.command', payload: { id: '123', qty: 5 } });
    expect(events1[0].type).toBe('order.line.updated.event');
    expect(events1[0].payload).toEqual({ lineId: '123', qty: 5 });

    const events2 = aggregate.process(orderState, { type: 'order.updateSubLine.command', payload: { lineId: '123', subId: 456, metadata: 'new' } });
    expect(events2[0].type).toBe('order.line.subitems.updated.event');
    expect(events2[0].payload).toEqual({ lineId: '123', subitemsId: 456, metadata: 'new' });
    const newState1 = aggregate.apply(orderState, events1[0]);
    expect(newState1.line[0].qty).toBe(5);
    expect(orderState.line[0].qty).toBe(1); // Immutability

    const newState2 = aggregate.apply(newState1, events2[0]);
    expect(newState2.line[0].subitems[0].metadata).toBe('new');
    expect(newState1.line[0].subitems[0].metadata).toBe('old');
  });
});
