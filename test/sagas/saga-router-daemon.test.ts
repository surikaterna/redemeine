import { describe, expect, it, jest } from '@jest/globals';
import {
  PendingIntentProjection,
  SagaRouterDaemon,
  SagaRouterDaemonHealthEvent,
  createSagaIntentRecordedEvents,
  createSagaTimeoutCronScanner,
  createSagaTimeoutWakeUpIntentRouter,
  type SagaIntentWorkerHandlers,
  type SagaReducerOutput
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('SagaRouterDaemon', () => {
  it('starts, emits health events, ticks, and stops cleanly', async () => {
    const processTick = jest.fn(async () => 2);
    const healthEvents: SagaRouterDaemonHealthEvent[] = [];
    const onHealthEvent = jest.fn((event: SagaRouterDaemonHealthEvent) => {
      healthEvents.push(event);
    });

    let timestampOrdinal = 0;
    const daemon = new SagaRouterDaemon({
      processTick,
      pollIntervalMs: 10,
      onHealthEvent,
      createTimestamp: () => `t-${++timestampOrdinal}`
    });

    const started = daemon.start();
    await new Promise(resolve => setTimeout(resolve, 25));
    daemon.stop();
    await started;

    expect(daemon.isRunning).toBe(false);
    expect(daemon.ticksProcessed).toBeGreaterThan(0);
    expect(processTick).toHaveBeenCalledTimes(daemon.ticksProcessed);

    expect(healthEvents[0]).toEqual({
      type: 'started',
      pollIntervalMs: 10,
      startedAt: 't-1'
    });

    const tickEvents = healthEvents.filter(
      (event): event is Extract<SagaRouterDaemonHealthEvent, { type: 'tick' }> => event.type === 'tick'
    );

    expect(tickEvents.length).toBe(daemon.ticksProcessed);
    expect(tickEvents[0].processedCount).toBe(2);

    const lastEvent = healthEvents[healthEvents.length - 1];
    expect(lastEvent.type).toBe('stopped');
    if (lastEvent.type === 'stopped') {
      expect(lastEvent.tickCount).toBe(daemon.ticksProcessed);
    }
  });

  it('supports manual tick processing count seam', async () => {
    const processTick = jest.fn(() => 5);
    const daemon = new SagaRouterDaemon({ processTick });

    await expect(daemon.tick()).resolves.toBe(5);
    expect(daemon.ticksProcessed).toBe(1);
    expect(processTick).toHaveBeenCalledTimes(1);
  });

  it('invokes logger hooks for started/tick/stopped health logs', async () => {
    const logger = {
      started: jest.fn(),
      tick: jest.fn(),
      stopped: jest.fn()
    };

    let daemon: SagaRouterDaemon;
    const processTick = jest
      .fn(async () => 1)
      .mockImplementation(async () => {
        daemon.stop();
        return 0;
      });

    daemon = new SagaRouterDaemon({
      pollIntervalMs: 0,
      processTick,
      logger
    });

    await daemon.start();

    expect(logger.started).toHaveBeenCalledTimes(1);
    expect(logger.tick).toHaveBeenCalled();
    expect(logger.stopped).toHaveBeenCalledTimes(1);
  });

  it('runs startup scan once before polling loop', async () => {
    let daemon: SagaRouterDaemon;
    const startupScan = jest.fn(async () => 1);
    const processTick = jest.fn(async () => {
      daemon.stop();
      return 0;
    });

    daemon = new SagaRouterDaemon({
      startupScan,
      processTick,
      pollIntervalMs: 0
    });

    await daemon.start();

    expect(startupScan).toHaveBeenCalledTimes(1);
    expect(processTick).toHaveBeenCalledTimes(1);
  });

  it('routes due timeout wake-up through worker pipeline during daemon tick', async () => {
    const projection = new PendingIntentProjection<BillingCommandMap>();
    const output: SagaReducerOutput<{ step: number }, BillingCommandMap> = {
      state: { step: 1 },
      intents: [
        {
          type: 'schedule',
          id: 'timer-daemon-due',
          delay: 500,
          metadata: { sagaId: 'saga-daemon', correlationId: 'corr-daemon', causationId: 'cause-daemon' }
        }
      ]
    };

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-daemon', output, () => '2026-03-31T00:00:00.000Z');
    projection.projectEvents([recorded], []);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter(projection, handlers);
    const timeoutScan = createSagaTimeoutCronScanner(projection, routeWakeUpIntent, {
      now: () => '2026-03-31T00:00:00.500Z'
    });

    const healthEvents: SagaRouterDaemonHealthEvent[] = [];
    let daemon: SagaRouterDaemon;
    const processTick = jest.fn(async () => {
      daemon.stop();
      return 0;
    });

    daemon = new SagaRouterDaemon({
      timeoutScan,
      processTick,
      pollIntervalMs: 0,
      onHealthEvent: event => healthEvents.push(event)
    });

    await daemon.start();

    expect(handlers.schedule).toHaveBeenCalledTimes(1);
    expect(handlers.dispatch).not.toHaveBeenCalled();
    expect(processTick).toHaveBeenCalledTimes(1);

    const tickEvents = healthEvents.filter(
      (event): event is Extract<SagaRouterDaemonHealthEvent, { type: 'tick' }> => event.type === 'tick'
    );
    expect(tickEvents).toHaveLength(1);
    expect(tickEvents[0].processedCount).toBe(1);
  });
});
