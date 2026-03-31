import { describe, expect, it, jest } from '@jest/globals';
import type { PendingIntentRecord, SagaIntentWorkerHandlers, SagaReducerOutput } from '../../src/sagas';
import {
  PendingIntentProjection,
  UnknownSagaIntentTypeError,
  createSagaIntentRecordedEvents,
  createSagaRouterProcessTick,
  resolveSagaWorkerHandlerPath,
  routePendingIntentByType
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

function createRecordFromIntent(
  intent: SagaReducerOutput<{ attempts: number }, BillingCommandMap>['intents'][number]
): PendingIntentRecord<BillingCommandMap> {
  const projection = new PendingIntentProjection<BillingCommandMap>();
  const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
    state: { attempts: 0 },
    intents: [intent]
  };

  const [recorded] = createSagaIntentRecordedEvents('saga-stream-route', output, () => '2026-03-31T00:00:00.000Z');
  projection.projectEvents([recorded], []);

  const record = projection.getByIntentKey(recorded.idempotencyKey);
  if (!record) {
    throw new Error('Expected pending intent record for routing test setup.');
  }

  return record;
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

    expect(handlers.dispatch).toHaveBeenCalledWith(
      dispatchRecord.intent as Parameters<SagaIntentWorkerHandlers<BillingCommandMap>['dispatch']>[0],
      dispatchRecord
    );
    expect(handlers.schedule).toHaveBeenCalledWith(
      scheduleRecord.intent as Parameters<SagaIntentWorkerHandlers<BillingCommandMap>['schedule']>[0],
      scheduleRecord
    );
    expect(handlers.cancelSchedule).toHaveBeenCalledWith(
      cancelRecord.intent as Parameters<SagaIntentWorkerHandlers<BillingCommandMap>['cancelSchedule']>[0],
      cancelRecord
    );
    expect(handlers.runActivity).toHaveBeenCalledWith(
      activityRecord.intent as Parameters<SagaIntentWorkerHandlers<BillingCommandMap>['runActivity']>[0],
      activityRecord
    );
  });

  it('throws clear error when resolving unknown intent type', () => {
    expect(() => resolveSagaWorkerHandlerPath('unknown-intent', 'intent-x')).toThrow(UnknownSagaIntentTypeError);

    try {
      resolveSagaWorkerHandlerPath('unknown-intent', 'intent-x');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownSagaIntentTypeError);
      const typed = error as UnknownSagaIntentTypeError;
      expect(typed.intentType).toBe('unknown-intent');
      expect(typed.intentKey).toBe('intent-x');
      expect(typed.message).toContain('Unknown saga intent type');
    }
  });

  it('process-tick routes executable pending intents through intent-type dispatch', async () => {
    const projection = new PendingIntentProjection<BillingCommandMap>();
    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-now', amount: 250 },
          metadata: { sagaId: 'saga-7', correlationId: 'corr-7', causationId: 'cause-7' }
        },
        {
          type: 'schedule',
          id: 'future-reminder',
          delay: 5_000,
          metadata: { sagaId: 'saga-7', correlationId: 'corr-7', causationId: 'cause-8' }
        }
      ]
    };

    const recorded = createSagaIntentRecordedEvents('saga-stream-router', output, () => '2026-03-31T00:00:00.000Z');
    projection.projectEvents(recorded, []);

    const routed: string[] = [];
    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async (_intent, _record) => routed.push('dispatch')),
      schedule: jest.fn(async (_intent, _record) => routed.push('schedule')),
      cancelSchedule: jest.fn(async (_intent, _record) => routed.push('cancel-schedule')),
      runActivity: jest.fn(async (_intent, _record) => routed.push('run-activity'))
    };

    const tick = createSagaRouterProcessTick(projection, handlers, {
      now: () => '2026-03-31T00:00:00.000Z'
    });

    await expect(tick()).resolves.toBe(1);
    expect(routed).toEqual(['dispatch']);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
    expect(handlers.schedule).not.toHaveBeenCalled();
  });
});
