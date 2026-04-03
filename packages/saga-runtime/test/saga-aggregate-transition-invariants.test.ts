import { describe, expect, it } from '@jest/globals';
import { createSagaAggregate, SagaTransitionInvariantError, type SagaAggregateState } from '../src/createSagaAggregate';

const isoAt = (secondsOffset: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, secondsOffset)).toISOString();

const expectInvariant = (
  execute: () => unknown,
  code: SagaTransitionInvariantError['code'],
  details: Record<string, unknown>
) => {
  try {
    execute();
    throw new Error('expected invariant rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(SagaTransitionInvariantError);
    const invariant = error as SagaTransitionInvariantError;
    expect(invariant.code).toBe(code);
    expect(invariant.details).toMatchObject(details);
  }
};

describe('saga aggregate transition invariants', () => {
  it('rejects transition and observation commands before instance creation', () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const state = aggregate.initialState;

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.recordStateTransition({ fromState: 'idle', toState: 'active' })),
      'saga_instance_not_created',
      { command: 'recordStateTransition', currentState: 'idle', transitionVersion: 0 }
    );

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.observeSourceEvent({ eventType: 'order.created.event' })),
      'saga_instance_not_created',
      { command: 'observeSourceEvent', currentState: 'idle', transitionVersion: 0 }
    );
  });

  it('rejects duplicate createInstance invocations', () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });

    const created = aggregate.process(
      aggregate.initialState,
      aggregate.commandCreators.createInstance({ id: 'saga-1', sagaType: 'shipping', createdAt: isoAt(1) })
    )[0];

    const state = aggregate.apply(aggregate.initialState, created);

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.createInstance({ id: 'saga-1', sagaType: 'shipping', createdAt: isoAt(2) })),
      'saga_instance_already_created',
      { command: 'createInstance', sagaId: 'saga-1', currentState: 'active' }
    );
  });

  it('rejects invalid sequencing: fromState mismatch, noop transitions, and post-terminal transitions', () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });

    let state: SagaAggregateState = aggregate.apply(
      aggregate.initialState,
      aggregate.process(
        aggregate.initialState,
        aggregate.commandCreators.createInstance({ id: 'saga-1', sagaType: 'shipping', createdAt: isoAt(1) })
      )[0]
    );

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.recordStateTransition({ fromState: 'idle', toState: 'completed' })),
      'saga_transition_from_state_mismatch',
      { command: 'recordStateTransition', sagaId: 'saga-1', currentState: 'active', fromState: 'idle', toState: 'completed' }
    );

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.recordStateTransition({ fromState: 'active', toState: 'active' })),
      'saga_transition_noop',
      { command: 'recordStateTransition', sagaId: 'saga-1', currentState: 'active', fromState: 'active', toState: 'active' }
    );

    const completedEvent = aggregate.process(
      state,
      aggregate.commandCreators.recordStateTransition({ fromState: 'active', toState: 'completed', transitionAt: isoAt(5) })
    )[0];
    state = aggregate.apply(state, completedEvent);

    expectInvariant(
      () => aggregate.process(state, aggregate.commandCreators.recordStateTransition({ fromState: 'completed', toState: 'failed' })),
      'saga_transition_from_terminal_state',
      { command: 'recordStateTransition', sagaId: 'saga-1', currentState: 'completed', fromState: 'completed', toState: 'failed' }
    );
  });
});
