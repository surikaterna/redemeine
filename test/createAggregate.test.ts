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
          close: (state) => {
            return { type: 'counter.closed.event', payload: 2 } as Event<number>;
          },
          project: (state, event) => {}
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
          project: (state, event: Event<{ with: number }>) => {
            state.value += event.payload.with;
          },
          increaseBy: (stateXX, command: Command<number>) => {
            return {
              type: 'counter.increasedBy.event',
              payload: { with: command.payload }
            } as Event<{ with: number }>;
          }
        },
        increased: {
          project: (state, event) => {
            state.value += 1;
          },
          increase: (stateXX, command: Command<void>) => {
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
          close: (state) => ({ type: 'counter.closed.event', payload: undefined } as Event),
          project: (state) => {}
        },
        cancelled: {
          cancel: (state) => ({ type: 'counter.cancelled.event', payload: undefined } as Event),
          project: (state) => {}
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
          close: (state, remark: string, remark2?: string) => {
            if (state.cancelled) {
              throw new Error('Already closed');
            }
            return { type: 'counter.closed.event', payload: { remark: remark + (remark2 || '') } } as Event<{ remark: string }>;
          },
          project: (state) => {
            state.cancelled = true;
          }
        }
      }
    });

    const commandResult = aggr.commands.close({ value: 12, cancelled: false }, 'hello', 'world');
    // We expect the command function we passed to return the mocked event payload structure
    expect((commandResult as any).payload.remark).toEqual('helloworld');
  });
});
