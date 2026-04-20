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

type OrderedCounterView = {
  id: string;
  total: number;
  events: number;
  appliedAmounts: number[];
  seenSequences: number[];
};

const CounterAggregate = {
  aggregateType: 'counter',
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

const orderedCounterProjection = {
  name: 'counter-view-ordered',
  fromStream: {
    aggregate: CounterAggregate as any,
    handlers: {
      'counter.incremented.event': (state: OrderedCounterView, event: any) => {
        state.id = event.aggregateId;
        state.total += Number(event.payload.amount);
        state.events += 1;
        state.appliedAmounts.push(Number(event.payload.amount));
        state.seenSequences.push(Number(event.sequence));
      }
    }
  },
  joinStreams: [],
  initialState: (id: string): OrderedCounterView => ({
    id,
    total: 0,
    events: 0,
    appliedAmounts: [],
    seenSequences: []
  }),
  identity: (event: { aggregateId: string }) => event.aggregateId,
  subscriptions: []
} as const;

describe('createTestDepot', () => {
  it('integrates projections through runtime v3 dynamic loading from core/store packages', async () => {
    const firstDepot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    const secondDepot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    await firstDepot.dispatch(CounterAggregate.commandCreators.increment('counter-runtime-1', 2));
    await secondDepot.dispatch(CounterAggregate.commandCreators.increment('counter-runtime-2', 6));
    await Promise.all([firstDepot.waitForIdle(), secondDepot.waitForIdle()]);

    await expect(firstDepot.projections.get(counterProjection, 'counter-runtime-1')).resolves.toEqual({
      id: 'counter-runtime-1',
      total: 2,
      events: 1
    });
    await expect(secondDepot.projections.get(counterProjection, 'counter-runtime-2')).resolves.toEqual({
      id: 'counter-runtime-2',
      total: 6,
      events: 1
    });
  });

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

  it('applies projection events in deterministic enqueue order', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [orderedCounterProjection]
    });

    const one = depot.dispatch(CounterAggregate.commandCreators.increment('counter-ordered', 3));
    const two = depot.dispatch(CounterAggregate.commandCreators.increment('counter-ordered', 1));
    const three = depot.dispatch(CounterAggregate.commandCreators.increment('counter-ordered', 4));

    await Promise.all([one, two, three]);
    await depot.waitForIdle();

    const view = await depot.projections.get(orderedCounterProjection, 'counter-ordered');
    expect(view).toEqual({
      id: 'counter-ordered',
      total: 8,
      events: 3,
      appliedAmounts: [3, 1, 4],
      seenSequences: [1, 2, 3]
    });
  });

  it('computes final projection state after many queued dispatches before a single waitForIdle', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    const pending = [
      depot.dispatch(CounterAggregate.commandCreators.increment('counter-a', 1)),
      depot.dispatch(CounterAggregate.commandCreators.increment('counter-b', 5)),
      depot.dispatch(CounterAggregate.commandCreators.increment('counter-a', 2)),
      depot.dispatch(CounterAggregate.commandCreators.increment('counter-b', 1)),
      depot.dispatch(CounterAggregate.commandCreators.increment('counter-a', 7))
    ];

    await depot.waitForIdle();
    await Promise.all(pending);

    await expect(depot.projections.get(counterProjection, 'counter-a')).resolves.toEqual({
      id: 'counter-a',
      total: 10,
      events: 3
    });
    await expect(depot.projections.get(counterProjection, 'counter-b')).resolves.toEqual({
      id: 'counter-b',
      total: 6,
      events: 2
    });
  });

  it('waitForIdle includes dispatches enqueued while an active drain is in-flight', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    const first = depot.dispatch(CounterAggregate.commandCreators.increment('counter-boundary', 2));
    const idle = depot.waitForIdle();
    const second = depot.dispatch(CounterAggregate.commandCreators.increment('counter-boundary', 3));

    await idle;
    await Promise.all([first, second]);

    await expect(depot.projections.get(counterProjection, 'counter-boundary')).resolves.toEqual({
      id: 'counter-boundary',
      total: 5,
      events: 2
    });
  });

  it('waitForIdle resolves immediately when already idle', async () => {
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    await expect(depot.waitForIdle()).resolves.toBeUndefined();
  });
});
