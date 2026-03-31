import { describe, expect, it } from '@jest/globals';
import {
  SagaRuntimeAggregate,
  deriveSagaRuntimeInstanceKey,
  shouldActivateSagaFromObservation,
  type SagaRuntimeDeadLetterIntentPayload,
  type SagaRuntimeFailIntentPayload,
  type SagaRuntimeObserveEventPayload,
  type SagaRuntimeQueueIntentPayload,
  type SagaRuntimeScheduleRetryPayload,
  type SagaRuntimeStartIntentPayload,
  type SagaRuntimeState
} from '../../src/sagas/SagaRuntimeAggregate';

const createIdleRuntimeState = (): SagaRuntimeState => ({
  lifecycle: 'idle',
  sagaInstanceKey: null,
  correlationId: null,
  startedAt: null,
  observedCount: 0,
  lastObservedAt: null,
  activeIntentKey: null,
  intents: {},
  completedIntentKeys: [],
  deadLetteredIntentKeys: []
});

function applyEvents(initialState: SagaRuntimeState, commands: Array<{ type: string; payload: unknown }>): SagaRuntimeState {
  return commands.reduce((state, command) => {
    const events = SagaRuntimeAggregate.process(state, command);
    return events.reduce((nextState, event) => SagaRuntimeAggregate.apply(nextState, event), state);
  }, initialState);
}

describe('R1 SagaRuntimeAggregate contract', () => {
  it('derives deterministic saga instance keys', () => {
    const first = deriveSagaRuntimeInstanceKey('billing-recovery', {
      customerId: 'cust-1',
      invoiceId: 'inv-1'
    });

    const sameDifferentOrder = deriveSagaRuntimeInstanceKey('billing-recovery', {
      invoiceId: 'inv-1',
      customerId: 'cust-1'
    });

    const differentCorrelation = deriveSagaRuntimeInstanceKey('billing-recovery', {
      customerId: 'cust-2',
      invoiceId: 'inv-1'
    });

    expect(first).toBe(sameDifferentOrder);
    expect(first).not.toBe(differentCorrelation);
    expect(deriveSagaRuntimeInstanceKey('inventory-recovery', { customerId: 'cust-1', invoiceId: 'inv-1' }))
      .not.toBe(first);
  });

  it('activates only start observations when idle', () => {
    const idleState: SagaRuntimeState = {
      ...createIdleRuntimeState()
    };

    const startObservation: SagaRuntimeObserveEventPayload = {
      sagaType: 'billing-recovery',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      isStart: true,
      observedAt: '2026-03-31T00:00:00.000Z'
    };

    expect(shouldActivateSagaFromObservation(idleState, startObservation)).toBe(true);

    expect(shouldActivateSagaFromObservation(idleState, {
      ...startObservation,
      isStart: false
    })).toBe(false);

    expect(shouldActivateSagaFromObservation({
      ...idleState,
      lifecycle: 'active',
      sagaInstanceKey: deriveSagaRuntimeInstanceKey(startObservation.sagaType, startObservation.correlationId),
      correlationId: startObservation.correlationId,
      startedAt: startObservation.observedAt
    }, startObservation)).toBe(false);
  });

  it('observeEvent command emits started exactly once for start activation', () => {
    const startPayload: SagaRuntimeObserveEventPayload = {
      sagaType: 'billing-recovery',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      isStart: true,
      observedAt: '2026-03-31T00:00:00.000Z'
    };

    const startEvents = SagaRuntimeAggregate.process(
      createIdleRuntimeState(),
      SagaRuntimeAggregate.commandCreators.observeEvent(startPayload)
    );

    expect(startEvents.map(event => event.type)).toEqual([
      'sagaRuntime.event.observed.event',
      'sagaRuntime.started.event'
    ]);

    const activeState = startEvents.reduce(
      (state, event) => SagaRuntimeAggregate.apply(state, event),
      createIdleRuntimeState()
    );

    const followUpEvents = SagaRuntimeAggregate.process(
      activeState,
      SagaRuntimeAggregate.commandCreators.observeEvent({
        ...startPayload,
        causationId: 'cause-2',
        isStart: true,
        observedAt: '2026-03-31T00:00:01.000Z'
      })
    );

    expect(followUpEvents.map(event => event.type)).toEqual([
      'sagaRuntime.event.observed.event'
    ]);
  });

  it('supports happy-path intent transitions', () => {
    const queuedAt = '2026-03-31T10:00:00.000Z';
    const startedAt = '2026-03-31T10:00:01.000Z';
    const completedAt = '2026-03-31T10:00:02.000Z';

    const queueIntent: SagaRuntimeQueueIntentPayload = {
      intentKey: 'intent-1',
      intentType: 'dispatch',
      queuedAt
    };

    const startIntent: SagaRuntimeStartIntentPayload = {
      intentKey: 'intent-1',
      startedAt
    };

    const finalState = applyEvents(createIdleRuntimeState(), [
      SagaRuntimeAggregate.commandCreators.queueIntent(queueIntent),
      SagaRuntimeAggregate.commandCreators.startIntent(startIntent),
      SagaRuntimeAggregate.commandCreators.completeIntent({
        intentKey: 'intent-1',
        completedAt
      })
    ]);

    expect(finalState.intents['intent-1']).toMatchObject({
      status: 'completed',
      attempts: 1,
      queuedAt,
      startedAt,
      completedAt
    });
    expect(finalState.activeIntentKey).toBeNull();
    expect(finalState.completedIntentKeys).toEqual(['intent-1']);
  });

  it('supports retry transitions after failure', () => {
    const scheduleRetry: SagaRuntimeScheduleRetryPayload = {
      intentKey: 'intent-2',
      attempt: 1,
      nextAttemptAt: '2026-03-31T10:15:00.000Z',
      scheduledAt: '2026-03-31T10:10:00.000Z'
    };

    const failIntent: SagaRuntimeFailIntentPayload = {
      intentKey: 'intent-2',
      failedAt: '2026-03-31T10:05:00.000Z',
      errorMessage: 'temporary outage'
    };

    const finalState = applyEvents(createIdleRuntimeState(), [
      SagaRuntimeAggregate.commandCreators.queueIntent({
        intentKey: 'intent-2',
        intentType: 'dispatch',
        queuedAt: '2026-03-31T10:00:00.000Z'
      }),
      SagaRuntimeAggregate.commandCreators.startIntent({
        intentKey: 'intent-2',
        startedAt: '2026-03-31T10:01:00.000Z'
      }),
      SagaRuntimeAggregate.commandCreators.failIntent(failIntent),
      SagaRuntimeAggregate.commandCreators.scheduleRetry(scheduleRetry),
      SagaRuntimeAggregate.commandCreators.startIntent({
        intentKey: 'intent-2',
        startedAt: '2026-03-31T10:16:00.000Z'
      }),
      SagaRuntimeAggregate.commandCreators.completeIntent({
        intentKey: 'intent-2',
        completedAt: '2026-03-31T10:16:30.000Z'
      })
    ]);

    expect(finalState.intents['intent-2']).toMatchObject({
      status: 'completed',
      attempts: 2,
      failedAt: null,
      nextAttemptAt: null,
      scheduledRetryAt: null
    });
  });

  it('guards terminal dead-lettered intents from further transitions', () => {
    const deadLetterIntent: SagaRuntimeDeadLetterIntentPayload = {
      intentKey: 'intent-3',
      attempt: 1,
      reason: 'non-retryable',
      errorMessage: 'permanent failure',
      deadLetteredAt: '2026-03-31T11:10:00.000Z'
    };

    const deadLetteredState = applyEvents(createIdleRuntimeState(), [
      SagaRuntimeAggregate.commandCreators.queueIntent({
        intentKey: 'intent-3',
        intentType: 'dispatch',
        queuedAt: '2026-03-31T11:00:00.000Z'
      }),
      SagaRuntimeAggregate.commandCreators.startIntent({
        intentKey: 'intent-3',
        startedAt: '2026-03-31T11:01:00.000Z'
      }),
      SagaRuntimeAggregate.commandCreators.failIntent({
        intentKey: 'intent-3',
        failedAt: '2026-03-31T11:05:00.000Z',
        errorMessage: 'permanent failure'
      }),
      SagaRuntimeAggregate.commandCreators.deadLetterIntent(deadLetterIntent)
    ]);

    expect(deadLetteredState.intents['intent-3']).toMatchObject({
      status: 'dead_lettered',
      deadLetterReason: 'non-retryable'
    });
    expect(deadLetteredState.deadLetteredIntentKeys).toEqual(['intent-3']);

    expect(() => SagaRuntimeAggregate.process(
      deadLetteredState,
      SagaRuntimeAggregate.commandCreators.scheduleRetry({
        intentKey: 'intent-3',
        attempt: 2,
        nextAttemptAt: '2026-03-31T11:20:00.000Z',
        scheduledAt: '2026-03-31T11:11:00.000Z'
      })
    )).toThrow("Intent 'intent-3' is terminal and cannot transition from 'dead_lettered'.");
  });
});
