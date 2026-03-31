import { describe, expect, it, jest } from '@jest/globals';
import type {
  RuntimeIntentProjectionRecordFor,
  SagaIntentWorkerHandlers,
  SagaReducerOutput,
  SagaTimerWakeUpIntent
} from '../../src/sagas';
import {
  InMemoryRuntimeIntentProjectionStore,
  SagaRouterDaemon,
  createSagaTimeoutCronScanner,
  createSagaTimeoutWakeUpIntentRouter
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S32 acceptance: due timeout routes wake-up and drives expected transition', () => {
  it('produces a wake-up and routes due schedule intent once', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
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

    const record: RuntimeIntentProjectionRecordFor<BillingCommandMap> = {
      intentKey: 'intent-timeout-acceptance',
      sagaStreamId: 'saga-stream-timeout-acceptance',
      intentType: output.intents[0].type,
      intent: output.intents[0],
      status: 'queued',
      attempts: 0,
      queuedAt: '2026-03-31T00:00:00.000Z',
      dueAt: '2026-03-31T00:00:00.500Z',
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      deadLetteredAt: null,
      lastErrorMessage: null
    };
    (projection as any).documents.set('intent:intent-timeout-acceptance', record);

    const sagaRuntimeState: { phase: 'waiting' | 'timed-out'; wakeUps: number } = {
      phase: 'waiting',
      wakeUps: 0
    };

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => {
        sagaRuntimeState.phase = 'timed-out';
        sagaRuntimeState.wakeUps += 1;
      }),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const typedProjection = {
      getDueIntents: (now?: string | Date) => projection.getDueIntents(now) as RuntimeIntentProjectionRecordFor<BillingCommandMap>[],
      getByIntentKey: (intentKey: string) => projection.getByIntentKey(intentKey) as RuntimeIntentProjectionRecordFor<BillingCommandMap> | null
    };

    const emittedWakeUps: SagaTimerWakeUpIntent[] = [];
    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter<BillingCommandMap>(typedProjection, handlers);
    const timeoutScan = createSagaTimeoutCronScanner(
      typedProjection,
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
    expect(daemon.ticksProcessed).toBe(1);
  });
});
