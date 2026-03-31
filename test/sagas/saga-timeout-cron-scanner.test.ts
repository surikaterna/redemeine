import { describe, expect, it, jest } from '@jest/globals';
import {
  PendingIntentProjection,
  type SagaReducerOutput,
  createSagaIntentRecordedEvents,
  createSagaTimeoutCronScanner,
  detectDueSagaTimers,
  toSagaTimerWakeUpIntent,
  type SagaTimerWakeUpIntent
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

function createProjectionWithDueAndFutureTimers(): PendingIntentProjection<BillingCommandMap> {
  const projection = new PendingIntentProjection<BillingCommandMap>();
  const output: SagaReducerOutput<{ step: number }, BillingCommandMap> = {
    state: { step: 1 },
    intents: [
      {
        type: 'dispatch',
        command: 'billing.charge',
        payload: { invoiceId: 'inv-dispatch', amount: 100 },
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-1'
        }
      },
      {
        type: 'schedule',
        id: 'timer-due',
        delay: 5_000,
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-2'
        }
      },
      {
        type: 'schedule',
        id: 'timer-future',
        delay: 10_000,
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-3'
        }
      }
    ]
  };

  const recordedEvents = createSagaIntentRecordedEvents(
    'saga-stream-1',
    output,
    () => '2026-03-30T00:00:00.000Z'
  );

  projection.projectEvents(recordedEvents, []);
  return projection;
}

describe('S18 saga timeout cron scanner', () => {
  it('detects only due schedule timers from pending intents', () => {
    const projection = createProjectionWithDueAndFutureTimers();

    const dueTimers = detectDueSagaTimers(projection, '2026-03-30T00:00:05.000Z');

    expect(dueTimers).toHaveLength(1);
    expect(dueTimers[0].intent.type).toBe('schedule');
    expect(dueTimers[0].intent.id).toBe('timer-due');
    expect(dueTimers[0].dueAt).toBe('2026-03-30T00:00:05.000Z');
  });

  it('maps due timer to wake-up intent envelope', () => {
    const projection = createProjectionWithDueAndFutureTimers();
    const dueTimer = detectDueSagaTimers(projection, '2026-03-30T00:00:05.000Z')[0];

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
    const projection = createProjectionWithDueAndFutureTimers();
    const emitted: SagaTimerWakeUpIntent[] = [];
    const emitWakeUpIntent = jest.fn(async (intent: SagaTimerWakeUpIntent) => {
      emitted.push(intent);
    });

    const scan = createSagaTimeoutCronScanner(projection, emitWakeUpIntent, {
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
