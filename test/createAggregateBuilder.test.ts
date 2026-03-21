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
      .overrideCommandNames({
        close: 'explicit.close.command'
      })
      .build();

    const cmd = aggregate.commandCreators.close(undefined);
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
});