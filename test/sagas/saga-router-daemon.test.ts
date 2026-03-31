import { describe, expect, it, jest } from '@jest/globals';
import { SagaRouterDaemon, SagaRouterDaemonHealthEvent } from '../../src/sagas';

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
});
