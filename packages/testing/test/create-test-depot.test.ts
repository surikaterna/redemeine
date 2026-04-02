import { describe, expect, it } from '@jest/globals';
import { createTestDepot } from '../src/createTestDepot';

type CounterState = {
  count: number;
};

type CounterView = {
  id: string;
  total: number;
  events: number;
};

const CounterAggregate = {
  __aggregateType: 'counter',
  initialState: { count: 0 } as CounterState,
  process(state: CounterState, command: { type: string; payload: { id: string; amount: number } }) {
    if (command.type === 'counter.increment.command') {
      return [
        {
          type: 'counter.incremented.event',
          payload: { amount: command.payload.amount },
          metadata: { aggregateId: command.payload.id }
        }
      ];
    }

    throw new Error(`Unknown command: ${command.type}`);
  },
  apply(state: CounterState, event: { type: string; payload: { amount: number } }) {
    if (event.type === 'counter.incremented.event') {
      return {
        ...state,
        count: state.count + event.payload.amount
      };
    }

    return state;
  },
  commandCreators: {
    increment(id: string, amount: number) {
      return {
        type: 'counter.increment.command',
        payload: { id, amount }
      };
    }
  },
  eventCreators: {},
  pure: {
    commandProcessors: {
      'counter.increment.command': () => undefined
    },
    eventProjectors: {}
  },
  selectors: {}
} as const;

const counterProjection = {
  name: 'counter-view',
  fromStream: {
    aggregate: CounterAggregate as any,
    handlers: {
      'counter.incremented.event': (state: CounterView, event: any) => {
        state.id = event.aggregateId;
        state.total += Number(event.payload.amount);
        state.events += 1;
      }
    }
  },
  joinStreams: [],
  initialState: (id: string): CounterView => ({
    id,
    total: 0,
    events: 0
  }),
  identity: (event: { aggregateId: string }) => event.aggregateId,
  subscriptions: []
} as const;

describe('createTestDepot', () => {
  it('processes command -> event -> projection deterministically', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    await depot.dispatch(CounterAggregate.commandCreators.increment('counter-1', 2));
    await depot.dispatch(CounterAggregate.commandCreators.increment('counter-1', 3));
    await depot.waitForIdle();

    const view = await depot.projections.get(counterProjection, 'counter-1');
    expect(view).toEqual({
      id: 'counter-1',
      total: 5,
      events: 2
    });
  });

  it('waitForIdle drains queued dispatches even when callers do not await dispatch', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    const one = depot.dispatch(CounterAggregate.commandCreators.increment('counter-2', 1));
    const two = depot.dispatch(CounterAggregate.commandCreators.increment('counter-2', 4));

    await depot.waitForIdle();
    await Promise.all([one, two]);

    const view = await depot.projections.get(counterProjection, 'counter-2');
    expect(view).toEqual({
      id: 'counter-2',
      total: 5,
      events: 2
    });

    await expect(depot.waitForIdle()).resolves.toBeUndefined();
  });
});
