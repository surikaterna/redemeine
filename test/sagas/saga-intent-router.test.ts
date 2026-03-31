import { describe, expect, it, jest } from '@jest/globals';
import type {
  RuntimeIntentProjectionRecordFor,
  SagaIntentWorkerHandlers,
  SagaReducerOutput
} from '../../src/sagas/internal/runtime';
import {
  UnknownSagaIntentTypeError,
  decidePendingIntentRoute,
  executePendingIntentRouteDecision,
  resolveSagaWorkerHandlerPath,
  routePendingIntentByType
} from '../../src/sagas/internal/runtime';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

function createRecordFromIntent(
  intent: SagaReducerOutput<{ attempts: number }, BillingCommandMap>['intents'][number],
  overrides: Partial<RuntimeIntentProjectionRecordFor<BillingCommandMap>> = {}
): RuntimeIntentProjectionRecordFor<BillingCommandMap> {
  return {
    intentKey: overrides.intentKey ?? 'saga-stream-route:0:test-hash',
    sagaStreamId: overrides.sagaStreamId ?? 'saga-stream-route',
    intentType: intent.type,
    intent,
    status: overrides.status ?? 'queued',
    attempts: overrides.attempts ?? 0,
    queuedAt: overrides.queuedAt ?? '2026-03-31T00:00:00.000Z',
    dueAt: overrides.dueAt ?? '2026-03-31T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    failedAt: overrides.failedAt ?? null,
    nextAttemptAt: overrides.nextAttemptAt ?? null,
    deadLetteredAt: overrides.deadLetteredAt ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null
  };
}

describe('S17 saga intent routing by type', () => {
  it('resolves each supported intent type to the expected worker handler path', () => {
    expect(resolveSagaWorkerHandlerPath('dispatch', 'intent-1')).toBe('worker.dispatch');
    expect(resolveSagaWorkerHandlerPath('schedule', 'intent-2')).toBe('worker.schedule');
    expect(resolveSagaWorkerHandlerPath('cancel-schedule', 'intent-3')).toBe('worker.cancelSchedule');
    expect(resolveSagaWorkerHandlerPath('run-activity', 'intent-4')).toBe('worker.runActivity');
  });

  it('routes each pending intent type to the matching worker handler', async () => {
    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async (_intent, _record) => undefined),
      schedule: jest.fn(async (_intent, _record) => undefined),
      cancelSchedule: jest.fn(async (_intent, _record) => undefined),
      runActivity: jest.fn(async (_intent, _record) => undefined)
    };

    const dispatchRecord = createRecordFromIntent({
      type: 'dispatch',
      command: 'billing.charge',
      payload: { invoiceId: 'inv-1', amount: 100 },
      metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-1' }
    });
    const scheduleRecord = createRecordFromIntent({
      type: 'schedule',
      id: 'reminder-1',
      delay: 500,
      metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-2' }
    });
    const cancelRecord = createRecordFromIntent({
      type: 'cancel-schedule',
      id: 'reminder-1',
      metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-3' }
    });
    const activityRecord = createRecordFromIntent({
      type: 'run-activity',
      name: 'charge-card',
      closure: async () => 'ok',
      metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-4' }
    });

    const dispatchDecision = await routePendingIntentByType(dispatchRecord, handlers);
    const scheduleDecision = await routePendingIntentByType(scheduleRecord, handlers);
    const cancelDecision = await routePendingIntentByType(cancelRecord, handlers);
    const activityDecision = await routePendingIntentByType(activityRecord, handlers);

    expect(dispatchDecision.handlerPath).toBe('worker.dispatch');
    expect(scheduleDecision.handlerPath).toBe('worker.schedule');
    expect(cancelDecision.handlerPath).toBe('worker.cancelSchedule');
    expect(activityDecision.handlerPath).toBe('worker.runActivity');
  });

  it('separates decision and execution phases for pending intent routing', async () => {
    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const dispatchRecord = createRecordFromIntent({
      type: 'dispatch',
      command: 'billing.charge',
      payload: { invoiceId: 'inv-split', amount: 111 },
      metadata: { sagaId: 'saga-split', correlationId: 'corr-split', causationId: 'cause-split' }
    });

    const decision = decidePendingIntentRoute(dispatchRecord);
    expect(handlers.dispatch).not.toHaveBeenCalled();

    await executePendingIntentRouteDecision({ decision, record: dispatchRecord }, handlers);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it('throws clear error when resolving unknown intent type', () => {
    expect(() => resolveSagaWorkerHandlerPath('unknown-intent', 'intent-x')).toThrow(UnknownSagaIntentTypeError);
  });

});
