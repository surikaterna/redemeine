import { describe, expect, it, jest } from '@jest/globals';
import type {
  RuntimeIntentProjectionRecordFor,
  SagaIntentWorkerHandlers,
  SagaReducerOutput
} from '../../src/sagas';
import {
  InMemoryRuntimeIntentProjectionStore,
  MissingSagaWakeUpIntentRecordError,
  UnknownSagaIntentTypeError,
  createSagaRouterProcessTick,
  createSagaStartupRequeueScan,
  createSagaTimeoutWakeUpIntentRouter,
  decidePendingIntentRoute,
  detectDueSagaTimers,
  executePendingIntentRouteDecision,
  resolveSagaWorkerHandlerPath,
  routePendingIntentByType,
  toSagaTimerWakeUpIntent
} from '../../src/sagas';

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

function createTypedRuntimeProjectionView(projection: InMemoryRuntimeIntentProjectionStore): {
  getDueIntents(now?: string | Date): RuntimeIntentProjectionRecordFor<BillingCommandMap>[];
  getByIntentKey(intentKey: string): RuntimeIntentProjectionRecordFor<BillingCommandMap> | null;
} {
  return {
    getDueIntents: now => projection.getDueIntents(now) as RuntimeIntentProjectionRecordFor<BillingCommandMap>[],
    getByIntentKey: intentKey => projection.getByIntentKey(intentKey) as RuntimeIntentProjectionRecordFor<BillingCommandMap> | null
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

  it('process-tick routes executable due intents', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
    const dispatchRecord = createRecordFromIntent({
      type: 'dispatch',
      command: 'billing.charge',
      payload: { invoiceId: 'inv-now', amount: 250 },
      metadata: { sagaId: 'saga-7', correlationId: 'corr-7', causationId: 'cause-7' }
    }, {
      intentKey: 'intent-now',
      dueAt: '2026-03-31T00:00:00.000Z'
    });
    const futureRecord = createRecordFromIntent({
      type: 'schedule',
      id: 'future-reminder',
      delay: 5_000,
      metadata: { sagaId: 'saga-7', correlationId: 'corr-7', causationId: 'cause-8' }
    }, {
      intentKey: 'intent-future',
      dueAt: '2026-03-31T00:00:05.000Z'
    });

    (projection as any).documents.set('intent:intent-now', dispatchRecord);
    (projection as any).documents.set('intent:intent-future', futureRecord);

    const routed: string[] = [];
    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => routed.push('dispatch')),
      schedule: jest.fn(async () => routed.push('schedule')),
      cancelSchedule: jest.fn(async () => routed.push('cancel-schedule')),
      runActivity: jest.fn(async () => routed.push('run-activity'))
    };

    const tick = createSagaRouterProcessTick<BillingCommandMap>(createTypedRuntimeProjectionView(projection), handlers, {
      now: () => '2026-03-31T00:00:00.000Z'
    });

    await expect(tick()).resolves.toBe(1);
    expect(routed).toEqual(['dispatch']);
  });

  it('startup requeue scan requeues only currently due intents', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
    const dueRecord = createRecordFromIntent({
      type: 'dispatch',
      command: 'billing.charge',
      payload: { invoiceId: 'inv-recover', amount: 175 },
      metadata: { sagaId: 'saga-recover', correlationId: 'corr-recover', causationId: 'cause-recover' }
    }, {
      intentKey: 'intent-recover',
      dueAt: '2026-03-31T00:00:00.000Z'
    });
    const futureRecord = createRecordFromIntent({
      type: 'dispatch',
      command: 'billing.charge',
      payload: { invoiceId: 'inv-later', amount: 90 },
      metadata: { sagaId: 'saga-recover', correlationId: 'corr-recover', causationId: 'cause-later' }
    }, {
      intentKey: 'intent-later',
      dueAt: '2026-03-31T00:00:10.000Z'
    });

    (projection as any).documents.set('intent:intent-recover', dueRecord);
    (projection as any).documents.set('intent:intent-later', futureRecord);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const scan = createSagaStartupRequeueScan<BillingCommandMap>(createTypedRuntimeProjectionView(projection), handlers, {
      now: () => '2026-03-31T00:00:00.000Z'
    });

    await expect(scan()).resolves.toBe(1);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it('routes timeout wake-up intents through normal worker pipeline', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
    const scheduleRecord = createRecordFromIntent({
      type: 'schedule',
      id: 'timer-due-through-router',
      delay: 500,
      metadata: { sagaId: 'saga-timeout', correlationId: 'corr-timeout', causationId: 'cause-timeout' }
    }, {
      intentKey: 'intent-timer',
      dueAt: '2026-03-31T00:00:00.500Z'
    });

    (projection as any).documents.set('intent:intent-timer', scheduleRecord);

    const dueTimerRecord = detectDueSagaTimers<BillingCommandMap>(createTypedRuntimeProjectionView(projection), '2026-03-31T00:00:00.500Z')[0];
    const wakeUpIntent = toSagaTimerWakeUpIntent(dueTimerRecord);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter<BillingCommandMap>(createTypedRuntimeProjectionView(projection), handlers);
    const decision = await routeWakeUpIntent(wakeUpIntent);

    expect(decision.handlerPath).toBe('worker.schedule');
    expect(handlers.schedule).toHaveBeenCalledTimes(1);
  });

  it('throws when timeout wake-up intent references missing record', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter<BillingCommandMap>(createTypedRuntimeProjectionView(projection), handlers);

    await expect(
      routeWakeUpIntent({
        type: 'saga.timer-wake-up',
        sagaStreamId: 'saga-stream-missing',
        intentKey: 'missing-key',
        scheduleId: 'timer-404',
        dueAt: '2026-03-31T00:00:00.000Z',
        metadata: { sagaId: 'saga-missing', correlationId: 'corr-missing', causationId: 'cause-missing' }
      })
    ).rejects.toBeInstanceOf(MissingSagaWakeUpIntentRecordError);
  });
});
