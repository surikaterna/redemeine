import { describe, expect, it, jest } from '@jest/globals';
import {
  InMemoryRuntimeIntentProjectionStore,
  createSagaTimeoutCronScanner,
  detectDueSagaTimers,
  toSagaTimerWakeUpIntent,
  type RuntimeIntentProjectionRecordFor,
  type SagaReducerOutput,
  type SagaTimerWakeUpIntent
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

function createRuntimeRecord(
  intent: SagaReducerOutput<{ step: number }, BillingCommandMap>['intents'][number],
  intentKey: string,
  dueAt: string
): RuntimeIntentProjectionRecordFor<BillingCommandMap> {
  return {
    intentKey,
    sagaStreamId: 'saga-stream-1',
    intentType: intent.type,
    intent,
    status: 'queued',
    attempts: 0,
    queuedAt: '2026-03-30T00:00:00.000Z',
    dueAt,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    lastErrorMessage: null
  };
}

function createProjectionWithDueAndFutureTimers() {
  const projection = new InMemoryRuntimeIntentProjectionStore();

  const dispatchIntent: SagaReducerOutput<{ step: number }, BillingCommandMap>['intents'][number] = {
    type: 'dispatch',
    command: 'billing.charge',
    payload: { invoiceId: 'inv-dispatch', amount: 100 },
    metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-1' }
  };
  const dueScheduleIntent: SagaReducerOutput<{ step: number }, BillingCommandMap>['intents'][number] = {
    type: 'schedule',
    id: 'timer-due',
    delay: 5_000,
    metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-2' }
  };
  const futureScheduleIntent: SagaReducerOutput<{ step: number }, BillingCommandMap>['intents'][number] = {
    type: 'schedule',
    id: 'timer-future',
    delay: 10_000,
    metadata: { sagaId: 'saga-1', correlationId: 'corr-1', causationId: 'cause-3' }
  };

  (projection as any).documents.set('intent:intent-dispatch', createRuntimeRecord(
    dispatchIntent,
    'intent-dispatch',
    '2026-03-30T00:00:00.000Z'
  ));
  (projection as any).documents.set('intent:intent-due', createRuntimeRecord(
    dueScheduleIntent,
    'intent-due',
    '2026-03-30T00:00:05.000Z'
  ));
  (projection as any).documents.set('intent:intent-future', createRuntimeRecord(
    futureScheduleIntent,
    'intent-future',
    '2026-03-30T00:00:10.000Z'
  ));

  const typedProjection = {
    getDueIntents: (now?: string | Date) => projection.getDueIntents(now) as RuntimeIntentProjectionRecordFor<BillingCommandMap>[]
  };

  return { projection, typedProjection };
}

describe('S18 saga timeout cron scanner', () => {
  it('detects only due schedule timers from runtime projection', () => {
    const { typedProjection } = createProjectionWithDueAndFutureTimers();

    const dueTimers = detectDueSagaTimers(typedProjection, '2026-03-30T00:00:05.000Z');

    expect(dueTimers).toHaveLength(1);
    expect(dueTimers[0].intent.type).toBe('schedule');
    expect(dueTimers[0].intent.id).toBe('timer-due');
    expect(dueTimers[0].dueAt).toBe('2026-03-30T00:00:05.000Z');
  });

  it('maps due timer to wake-up intent envelope', () => {
    const { typedProjection } = createProjectionWithDueAndFutureTimers();
    const dueTimer = detectDueSagaTimers(typedProjection, '2026-03-30T00:00:05.000Z')[0];

    const wakeUp = toSagaTimerWakeUpIntent(dueTimer);

    expect(wakeUp).toEqual({
      type: 'saga.timer-wake-up',
      sagaStreamId: 'saga-stream-1',
      intentKey: dueTimer.intentKey,
      scheduleId: 'timer-due',
      dueAt: '2026-03-30T00:00:05.000Z',
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-2'
      }
    });
  });

  it('emits wake-up intents for each due timer and returns count', async () => {
    const { typedProjection } = createProjectionWithDueAndFutureTimers();
    const emitted: SagaTimerWakeUpIntent[] = [];
    const emitWakeUpIntent = jest.fn(async (intent: SagaTimerWakeUpIntent) => {
      emitted.push(intent);
    });

    const scan = createSagaTimeoutCronScanner(typedProjection, emitWakeUpIntent, {
      now: () => '2026-03-30T00:00:05.000Z'
    });

    await expect(scan()).resolves.toBe(1);
    expect(emitWakeUpIntent).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toMatchObject({
      type: 'saga.timer-wake-up',
      scheduleId: 'timer-due',
      dueAt: '2026-03-30T00:00:05.000Z'
    });
  });
});
