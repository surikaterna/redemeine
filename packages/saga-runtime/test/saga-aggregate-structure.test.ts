import { describe, expect, it } from '@jest/globals';
import { createSagaAggregate } from '../src/createSagaAggregate';

const isoAt = (secondsOffset: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, secondsOffset)).toISOString();

const expectIso8601 = (value: string) => {
  const parsed = new Date(value);
  expect(Number.isNaN(parsed.getTime())).toBe(false);
  expect(parsed.toISOString()).toBe(value);
};

describe('createSagaAggregate structure contracts', () => {
  it('uses snake_case wire type names while command/event keys remain camelCase', () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });

    const commandKeys = Object.keys(aggregate.pure.commandProcessors);
    const eventKeys = Object.keys(aggregate.pure.eventProjectors);

    expect(commandKeys).toContain('recordStateTransition');
    expect(commandKeys).not.toContain('record_state_transition');
    expect(eventKeys).toContain('stateTransitioned');
    expect(eventKeys).not.toContain('state_transitioned');

    const command = aggregate.commandCreators.recordStateTransition({
      fromState: 'idle',
      toState: 'active',
      transitionAt: isoAt(1)
    });
    const event = aggregate.eventCreators.stateTransitioned({
      record: {
        fromState: 'idle',
        toState: 'active',
        transitionAt: isoAt(1)
      }
    });

    expect(command.type).toBe('saga.record_state_transition.command');
    expect(event.type).toBe('saga.state_transitioned.event');
  });

  it('normalizes timestamps to ISO8601 and advances updatedAt/transitionVersion', () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    let state = aggregate.initialState;

    const createdAtInput = '2026-01-01T00:00:01Z';
    const transitionAtInput = '2026-01-01T00:00:02+00:00';
    const observedAtInput = '2026-01-01T00:00:03+00:00';

    const createEvent = aggregate.process(
      state,
      aggregate.commandCreators.createInstance({
        id: 'saga-1',
        sagaType: 'shipping',
        createdAt: createdAtInput
      })
    )[0];
    state = aggregate.apply(state, createEvent);

    expect(state.createdAt).toBe('2026-01-01T00:00:01.000Z');
    expect(state.updatedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(state.transitionVersion).toBe(1);
    expectIso8601(state.createdAt!);
    expectIso8601(state.updatedAt!);

    const transitionEvent = aggregate.process(
      state,
      aggregate.commandCreators.recordStateTransition({
        fromState: 'active',
        toState: 'completed',
        transitionAt: transitionAtInput
      })
    )[0];
    state = aggregate.apply(state, transitionEvent);

    expect(state.createdAt).toBe('2026-01-01T00:00:01.000Z');
    expect(state.updatedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(state.transitionVersion).toBe(2);

    const observedEvent = aggregate.process(
      state,
      aggregate.commandCreators.observeSourceEvent({
        eventType: 'order.approved.event',
        observedAt: observedAtInput
      })
    )[0];
    state = aggregate.apply(state, observedEvent);

    expect(state.updatedAt).toBe('2026-01-01T00:00:03.000Z');
    expect(state.transitionVersion).toBe(3);
    expect(new Date(state.updatedAt!).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:02.000Z').getTime());
  });

  it('truncates recent windows while totals continue accumulating', () => {
    const aggregate = createSagaAggregate({
      aggregateName: 'saga',
      recentWindowLimits: {
        transitions: 3,
        events: 2,
        intents: 2,
        activities: 2
      }
    });

    let state = aggregate.apply(
      aggregate.initialState,
      aggregate.process(
        aggregate.initialState,
        aggregate.commandCreators.createInstance({ id: 'saga-1', sagaType: 'shipping', createdAt: isoAt(0) })
      )[0]
    );

    for (let i = 1; i <= 5; i += 1) {
      state = aggregate.apply(
        state,
        aggregate.process(
          state,
          aggregate.commandCreators.recordStateTransition({
            fromState: state.lifecycleState,
            toState: `state-${i}`,
            transitionAt: isoAt(i * 10)
          })
        )[0]
      );

      state = aggregate.apply(
        state,
        aggregate.process(
          state,
          aggregate.commandCreators.observeSourceEvent({
            eventType: `event-${i}`,
            observedAt: isoAt(i * 10 + 1)
          })
        )[0]
      );

      state = aggregate.apply(
        state,
        aggregate.process(
          state,
          aggregate.commandCreators.recordIntentLifecycle({
            intentId: `intent-${i}`,
            intentType: 'dispatch',
            stage: 'created',
            recordedAt: isoAt(i * 10 + 2)
          })
        )[0]
      );

      state = aggregate.apply(
        state,
        aggregate.process(
          state,
          aggregate.commandCreators.recordActivityLifecycle({
            activityId: `activity-${i}`,
            activityName: 'call-external',
            stage: 'started',
            recordedAt: isoAt(i * 10 + 3)
          })
        )[0]
      );
    }

    expect(state.recent.transitions).toHaveLength(3);
    expect(state.recent.transitions.map((entry) => entry.toState)).toEqual(['state-5', 'state-4', 'state-3']);
    expect(state.recent.events).toHaveLength(2);
    expect(state.recent.events.map((entry) => entry.eventType)).toEqual(['event-5', 'event-4']);
    expect(state.recent.intents).toHaveLength(2);
    expect(state.recent.intents.map((entry) => entry.intentId)).toEqual(['intent-5', 'intent-4']);
    expect(state.recent.activities).toHaveLength(2);
    expect(state.recent.activities.map((entry) => entry.activityId)).toEqual(['activity-5', 'activity-4']);

    expect(state.totals.transitions).toBe(5);
    expect(state.totals.observedEvents).toBe(5);
    expect(state.totals.intents).toBe(5);
    expect(state.totals.activities).toBe(5);
  });
});
