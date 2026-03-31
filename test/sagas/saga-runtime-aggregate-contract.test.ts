import { describe, expect, it } from '@jest/globals';
import {
  SagaRuntimeAggregate,
  deriveSagaRuntimeInstanceKey,
  shouldActivateSagaFromObservation,
  type SagaRuntimeObserveEventPayload,
  type SagaRuntimeState
} from '../../src/sagas/SagaRuntimeAggregate';

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
      lifecycle: 'idle',
      sagaInstanceKey: null,
      correlationId: null,
      startedAt: null,
      observedCount: 0,
      lastObservedAt: null
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
      {
        lifecycle: 'idle',
        sagaInstanceKey: null,
        correlationId: null,
        startedAt: null,
        observedCount: 0,
        lastObservedAt: null
      },
      SagaRuntimeAggregate.commandCreators.observeEvent(startPayload)
    );

    expect(startEvents.map(event => event.type)).toEqual([
      'sagaRuntime.event.observed.event',
      'sagaRuntime.started.event'
    ]);

    const activeState = startEvents.reduce(
      (state, event) => SagaRuntimeAggregate.apply(state, event),
      {
        lifecycle: 'idle',
        sagaInstanceKey: null,
        correlationId: null,
        startedAt: null,
        observedCount: 0,
        lastObservedAt: null
      } as SagaRuntimeState
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
});
