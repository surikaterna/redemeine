import { describe, expect, it, jest } from '@jest/globals';
import type { SagaIntentWorkerHandlers, SagaReducerOutput, SagaTimerWakeUpIntent } from '../../src/sagas';
import {
  PendingIntentProjection,
  SagaRouterDaemon,
  createSagaIntentDispatchedEvent,
  createSagaIntentRecordedEvents,
  createSagaTimeoutCronScanner,
  createSagaTimeoutWakeUpIntentRouter
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S32 acceptance: due timeout routes wake-up and drives expected transition', () => {
  it('produces a wake-up and transitions pending schedule execution to dispatched', async () => {
    const projection = new PendingIntentProjection<BillingCommandMap>();
    const output: SagaReducerOutput<{ phase: 'waiting' | 'timed-out'; wakeUps: number }, BillingCommandMap> = {
      state: { phase: 'waiting', wakeUps: 0 },
      intents: [
        {
          type: 'schedule',
          id: 'timer-timeout-acceptance',
          delay: 500,
          metadata: {
            sagaId: 'saga-timeout-acceptance',
            correlationId: 'corr-timeout-acceptance',
            causationId: 'cause-timeout-acceptance'
          }
        }
      ]
    };

    const [recorded] = createSagaIntentRecordedEvents(
      'saga-stream-timeout-acceptance',
      output,
      () => '2026-03-31T00:00:00.000Z'
    );
    projection.projectEvents([recorded], []);

    const initialPending = projection.getByIntentKey(recorded.idempotencyKey);
    expect(initialPending?.status).toBe('pending');

    const sagaRuntimeState: { phase: 'waiting' | 'timed-out'; wakeUps: number } = {
      phase: 'waiting',
      wakeUps: 0
    };

    const scheduleHandler: SagaIntentWorkerHandlers<BillingCommandMap>['schedule'] = async (_intent, record) => {
      sagaRuntimeState.phase = 'timed-out';
      sagaRuntimeState.wakeUps += 1;

      const dispatched = createSagaIntentDispatchedEvent(
        {
          sagaStreamId: record.sagaStreamId,
          intentKey: record.intentKey,
          metadata: record.intent.metadata
        },
        () => '2026-03-31T00:00:00.500Z'
      );
      projection.projectLifecycleEvent(dispatched);
    };

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(scheduleHandler),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const emittedWakeUps: SagaTimerWakeUpIntent[] = [];
    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter(projection, handlers);
    const timeoutScan = createSagaTimeoutCronScanner(
      projection,
      async wakeUpIntent => {
        emittedWakeUps.push(wakeUpIntent);
        await routeWakeUpIntent(wakeUpIntent);
      },
      { now: () => '2026-03-31T00:00:00.500Z' }
    );

    let daemon: SagaRouterDaemon;
    const processTick = jest.fn(async () => {
      daemon.stop();
      return 0;
    });

    daemon = new SagaRouterDaemon({
      timeoutScan,
      processTick,
      pollIntervalMs: 0
    });

    await daemon.start();

    expect(emittedWakeUps).toHaveLength(1);
    expect(emittedWakeUps[0]).toMatchObject({
      type: 'saga.timer-wake-up',
      scheduleId: 'timer-timeout-acceptance',
      dueAt: '2026-03-31T00:00:00.500Z'
    });

    expect(handlers.schedule).toHaveBeenCalledTimes(1);
    expect(sagaRuntimeState).toEqual({
      phase: 'timed-out',
      wakeUps: 1
    });

    const transitioned = projection.getByIntentKey(recorded.idempotencyKey);
    expect(transitioned?.status).toBe('dispatched');
    expect(daemon.ticksProcessed).toBe(1);
  });
});
