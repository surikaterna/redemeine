import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { Command } from '../src/createCommand';
import { Event } from '../src/createEvent';

describe('createAggregate', () => {
  interface CounterState {
    value: number;
    cancelled?: boolean;
  }

  test('create event projectors from event def', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0 } as CounterState,
      events: {
        closed: {
          close: (state: CounterState) => {
            return { type: 'counter.closed.event', payload: 2 } as Event<number>;
          },
          project: (state: CounterState) => {}
        }
      }
    });

    expect(Object.keys(aggr.projectors)).toHaveLength(1);
    expect(aggr.projectors).toHaveProperty('closed');
  });

  test('event projectors from event def should update the state immutably', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0 } as CounterState,
      events: {
        increasedBy: {
          project: (state: CounterState, event: Event<{ with: number }>) => {
            state.value += event.payload.with;
          },
          increaseBy: (state: CounterState, command: Command<number>) => {
            // Un-commenting the following line would cause a TypeScript error because state is ReadonlyDeep:
            // state.value = 100;
            return {
              type: 'counter.increasedBy.event',
              payload: { with: command.payload }
            } as Event<{ with: number }>;
          }
        },
        increased: {
          project: (state: CounterState) => {
            state.value += 1;
          },
          increase: (state: CounterState, command: Command<void>) => {
            return {
              type: 'counter.increased.event',
              payload: undefined
            } as Event;
          }
        }
      }
    });

    const mockState = { value: 12 };

    // Test that Immer successfully mutates a draft and maintains immutability of original
    const newState = aggr.projectors.increasedBy(mockState, {
      type: 'counter.increasedBy.event',
      payload: { with: 12 }
    });

    expect(newState.value).toBe(24); // New state is updated
    expect(mockState.value).toBe(12); // Original state remains untouched
  });

  test('create commands structure from event def', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0 } as CounterState,
      events: {
        closed: {
          close: (state: CounterState) => ({ type: 'counter.closed.event', payload: undefined } as Event),
          project: (state: CounterState) => {}
        },
        cancelled: {
          cancel: (state: CounterState) => ({ type: 'counter.cancelled.event', payload: undefined } as Event),
          project: (state: CounterState) => {}
        }
      }
    });
    expect(Object.keys(aggr.commands)).toHaveLength(2);
    expect(aggr.commands).toHaveProperty('close');
    expect(aggr.commands).toHaveProperty('cancel');
  });

  test('command is callable from events spec', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: {
        value: 0,
        cancelled: false
      } as CounterState,
      events: {
        closed: {
          close: (state: CounterState, payload: { remark: string, remark2?: string }) => {
            if (state.cancelled) {
              throw new Error('Already closed');
            }
            return { type: 'counter.closed.event', payload: { remark: payload.remark + (payload.remark2 || '') } } as Event<{ remark: string }>;
          },
          project: (state: CounterState) => {
            state.cancelled = true;
          }
        }
      }
    });

    const commandResult = aggr.commands.close({ value: 12, cancelled: false }, { remark: 'hello', remark2: 'world' });
    // We expect the command function we passed to return the mocked event payload structure
    expect((commandResult as any).payload.remark).toEqual('helloworld');
  });

  test('support 1:m root commands and standalone events without mapping', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0, cancelled: false } as CounterState,
      commands: {
        // High-level command that throws multiple events (1:m)
        processBatch: (state: CounterState, batch: number[], emit: any, invoke: any) => {
          let events: Event[] = [];
          for (const item of batch) {
            // we must be aware that `state` evaluates magically with the latest updates!
            const resultEvents = invoke.increaseBy(item);
            // We concat local returns up to the caller
            events = events.concat(resultEvents);
          }
          return events; // 1:M return
        }
      },
      events: {
        increasedBy: {
          project: (state: CounterState, event: Event<number>) => {
            state.value += event.payload;
          },
          increaseBy: (state: CounterState, amount: number, emit: any) => {
            const evs = [emit.increasedBy(amount)];
            // `state` is a Proxy to the latest evaluated state injected implicitly!
            if (state.value + amount > 100) {
              evs.push(emit.maxCapacityReached());
            }
            return evs;
          }
        },
        maxCapacityReached: {
          // Event with no 1:1 mapped command! Purely reacting to things.
          project: (state: CounterState, event: Event<void>) => {
            state.cancelled = true;
          }
        }
      }
    });

    const rootCommandResult = aggr.commands.processBatch({ value: 90, cancelled: false }, [5, 20]);

    // Should return an array with 3 events: two +increases, and one capacity reached
    expect(Array.isArray(rootCommandResult)).toBe(true);
    expect((rootCommandResult as Event[]).length).toBe(3);
    expect((rootCommandResult as Event[])[2].type).toBe('counter.maxCapacityReached.event');

    // Test the event-only projector
    const newState = aggr.projectors.maxCapacityReached({ value: 105, cancelled: false }, { type: 'counter.maxCapacityReached.event', payload: undefined } as Event);
    expect(newState.cancelled).toBe(true);
  });
} 

) 
; 
