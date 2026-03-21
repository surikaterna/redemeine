import { createAggregateBuilder } from '../src/createAggregateBuilder';
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
  .commands((emit) => ({
    increment: (state, amount: number) => emit.incremented({ amount })
  }))
  .overrideCommandNames({
    increment: 'legacy.counter.increment.command'
  })
  .build();

// --- The Test Suite ---

describe('Aggregate Builder with Mixins', () => {
  
  it('should handle core commands and default naming strategy', () => {
    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState)
      .events({
        opened: (state, event: Event<{ id: string }>) => {
          state.id = event.payload.id;
        }
      })
      .commands((emit) => ({
        open: (state, id: string) => emit.opened({ id })
      }))
      .build();

    // Test Command Creator Name
    const cmd = aggregate.commandCreators.open('123');
    expect(cmd.type).toBe('test.open.command');

    // Test Handle -> Apply lifecycle
    const events = aggregate.handle(initialState, 'test.open.command', '123');
    expect(events[0].type).toBe('test.opened.event');

    const newState = aggregate.apply(initialState, events[0]);
    expect(newState.id).toBe('123');
  });

  it('should correctly merge mixin commands and events', () => {
    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState)
      .mixins(counterMixin)
      .build();

    // 1. Check if mixin command exists on creators
    const cmd = aggregate.commandCreators.increment(5);
    expect(cmd.type).toBe('legacy.counter.increment.command');

    // 2. Check if handle recognizes the overridden mixin command
    const events = aggregate.handle(initialState, 'legacy.counter.increment.command', 5);
    expect(events[0].type).toBe('legacy.counter.incremented.event');
    expect(events[0].payload).toEqual({ amount: 5 });

    // 3. Check if apply processes the mixin event
    const newState = aggregate.apply(initialState, events[0]);
    expect(newState.count).toBe(5);
  });

  it('should allow core overrides to take precedence or coexist', () => {
    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState)
      .events({
        closed: (state) => { state.status = 'closed'; }
      })
      .commands((emit) => ({
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

    const events = aggregate.handle(initialState, 'explicit.close.command', undefined);
    expect(events[0].type).toBe('explicit.closed.event');
  });

  it('should throw an error when handling an unknown command', () => {
    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState).build();
    
    expect(() => {
      aggregate.handle(initialState, 'ghost.command', {});
    }).toThrow('Unknown command: ghost.command');
  });

  it('should maintain immutability using Immer', () => {
    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState)
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
      .commands((emit) => ({
        changeStatus: (state, status: string) => emit.statusChanged(status)
      }))
      .overrideCommandNames({})
      .build();

    const aggregate = createAggregateBuilder<TestState, 'test'>('test', initialState)
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

    const aggregate = createAggregateBuilder<OrderState, 'order'>('order', orderState)
      .entities<{ line: OrderLine; subitems: SubOrderLine }>()
      .events({
        updated: (state: any, event: Event<{ qty?: number; metadata?: string }>) => {
          if (event.payload.qty !== undefined) state.qty = event.payload.qty;
          if (event.payload.metadata !== undefined) state.metadata = event.payload.metadata;
        }
      })
      .commands((emit: any) => ({
        // Targeting line
        updateLine: (state, payload: { id: string; qty: number }) => 
          emit.lineUpdated(payload.id, { qty: payload.qty }),
        
        // Targeting subitems
        updateSubLine: (state, payload: { lineId: string; subId: number; metadata: string }) => 
          emit.lineSubitemsUpdated(payload.lineId, payload.subId, { metadata: payload.metadata })
      }))
      .build();

    // 1. Check generated event types
    // Using handle to invoke command
    const events1 = aggregate.handle(orderState, 'order.updateLine.command', { id: '123', qty: 5 });
    expect(events1[0].type).toBe('order.line[123].updated.event');
    expect(events1[0].payload).toEqual({ qty: 5 });

    const events2 = aggregate.handle(orderState, 'order.updateSubLine.command', { lineId: '123', subId: 456, metadata: 'new' });
    expect(events2[0].type).toBe('order.line[123].subitems[456].updated.event');
    expect(events2[0].payload).toEqual({ metadata: 'new' });

    // 2. Check apply logic routes correctly to nested entities
    const newState1 = aggregate.apply(orderState, events1[0]);
    expect(newState1.line[0].qty).toBe(5);
    expect(orderState.line[0].qty).toBe(1); // Immutability

    const newState2 = aggregate.apply(newState1, events2[0]);
    expect(newState2.line[0].subitems[0].metadata).toBe('new');
    expect(newState1.line[0].subitems[0].metadata).toBe('old');
  });
});
