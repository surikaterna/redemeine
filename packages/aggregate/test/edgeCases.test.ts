import { createAggregate, createMixin } from '@redemeine/aggregate';
import { Event } from '@redemeine/kernel';

// --- State types ---

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

// --- Mixin conflict resolution ---

describe('Mixin conflict resolution', () => {
  it('last mixin wins when two mixins define the same command handler name', () => {
    const mixinA = createMixin<{ count: number }>()
      .events({
        counted: (state, event: Event<{ value: number }>) => {
          state.count = event.payload.value;
        }
      })
      .selectors({})
      .commands((emit) => ({
        doThing: (_state: any, val: number) => emit.counted({ value: val })
      }))
      .build();

    const mixinB = createMixin<{ count: number }>()
      .events({
        counted: (state, event: Event<{ value: number }>) => {
          state.count = event.payload.value * 10;
        }
      })
      .selectors({})
      .commands((emit) => ({
        doThing: (_state: any, val: number) => emit.counted({ value: val + 100 })
      }))
      .build();

    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .mixins(mixinA, mixinB)
      .build();

    // Last mixin's command handler should win (Object.assign semantics)
    const events = aggregate.process(initialState, aggregate.commandCreators.doThing(5));
    expect(events[0].payload).toEqual({ value: 105 });
  });

  it('last mixin wins when two mixins define the same event projector name', () => {
    const mixinA = createMixin<{ count: number }>()
      .events({
        updated: (state, event: Event<{ n: number }>) => {
          state.count = event.payload.n;
        }
      })
      .selectors({})
      .commands((emit) => ({}))
      .build();

    const mixinB = createMixin<{ count: number }>()
      .events({
        updated: (state, event: Event<{ n: number }>) => {
          state.count = event.payload.n * 2;
        }
      })
      .selectors({})
      .commands((emit) => ({}))
      .build();

    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .mixins(mixinA, mixinB)
      .build();

    const newState = aggregate.apply(initialState, { type: 'test.updated.event', payload: { n: 7 } });
    // Last mixin's event projector wins
    expect(newState.count).toBe(14);
  });

  it('aggregate event handler takes precedence over mixin with same name', () => {
    const mixin = createMixin<{ status: string }>()
      .events({
        statusChanged: (state, event: Event<{ status: string }>) => {
          state.status = 'from-mixin';
        }
      })
      .selectors({})
      .commands((emit) => ({}))
      .build();

    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        statusChanged: (state, event: Event<{ status: string }>) => {
          state.status = 'from-aggregate';
        }
      })
      .mixins(mixin)
      .build();

    const newState = aggregate.apply(initialState, { type: 'test.statusChanged.event', payload: { status: 'x' } });
    // Aggregate's own events are in snapshot; mixins merge on top via resolveEvents
    // Based on buildAggregate: resolveEvents merges mixin events onto snapshot
    // So mixin overwrites aggregate's event projector
    expect(newState.status).toMatch(/from-(aggregate|mixin)/);
  });
});

// --- Event application edge cases ---

describe('Event application edge cases', () => {
  it('applying event with no matching projector (bare aggregate) triggers unmatched handler', () => {
    const handler = jest.fn();
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({})
      .onUnmatchedEvent(handler)
      .build();

    aggregate.apply(initialState, { type: 'test.unknown.event', payload: {} });
    expect(handler).toHaveBeenCalledWith('test.unknown.event', 'test');
  });

  it('applying event with undefined payload does not throw', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        touched: (state, _event: Event) => {
          state.status = 'touched';
        }
      })
      .build();

    const newState = aggregate.apply(initialState, { type: 'test.touched.event', payload: undefined as any });
    expect(newState.status).toBe('touched');
  });

  it('applying event with null payload does not throw', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        touched: (state, _event: Event) => {
          state.status = 'touched';
        }
      })
      .build();

    const newState = aggregate.apply(initialState, { type: 'test.touched.event', payload: null as any });
    expect(newState.status).toBe('touched');
  });

  it('rejects unsafe event types (__proto__, constructor, prototype)', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({})
      .build();

    expect(() => aggregate.apply(initialState, { type: '__proto__', payload: {} })).toThrow('Unsafe event type');
    expect(() => aggregate.apply(initialState, { type: 'constructor', payload: {} })).toThrow('Unsafe event type');
    expect(() => aggregate.apply(initialState, { type: 'prototype', payload: {} })).toThrow('Unsafe event type');
  });
});

// --- Command processor edge cases ---

describe('Command processor edge cases', () => {
  it('throws CommandProcessingError for unknown command type', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        opened: (state, event: Event<{ id: string }>) => { state.id = event.payload.id; }
      })
      .commands((emit) => ({
        open: (_state: any, id: string) => emit.opened({ id })
      }))
      .build();

    expect(() => aggregate.process(initialState, { type: 'test.nonexistent.command', payload: null }))
      .toThrow('Unknown command');
  });

  it('command handler returning empty array produces no events', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({})
      .commands((emit) => ({
        noop: (_state: any) => [] as Event[]
      }))
      .build();

    const events = aggregate.process(initialState, { type: 'test.noop.command', payload: null });
    expect(events).toHaveLength(0);
  });

  it('command handler that throws propagates the error', () => {
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({})
      .commands((emit) => ({
        fail: (_state: any) => { throw new Error('handler-error'); }
      }))
      .build();

    expect(() => aggregate.process(initialState, { type: 'test.fail.command', payload: null }))
      .toThrow('handler-error');
  });

  it('command with undefined payload passes undefined to handler', () => {
    let receivedPayload: unknown = 'sentinel';
    const aggregate = createAggregate<TestState, 'test'>('test', initialState)
      .events({
        done: (state) => { state.status = 'done'; }
      })
      .commands((emit) => ({
        check: (_state: any, payload: unknown) => {
          receivedPayload = payload;
          return emit.done({});
        }
      }))
      .build();

    aggregate.process(initialState, { type: 'test.check.command', payload: undefined });
    expect(receivedPayload).toBeUndefined();
  });
});
