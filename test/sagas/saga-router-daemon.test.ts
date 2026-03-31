import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import { ProjectionDaemon, type IEventSubscription, type ProjectionEvent } from '../../src/projections';
import {
  InMemoryRuntimeIntentProjectionStore,
  SagaRouterDaemon,
  SagaRouterDaemonHealthEvent,
  createRuntimeIntentProjection,
  createRuntimeStartupRecoveryScan,
  createSagaTimeoutCronScanner,
  createSagaTimeoutWakeUpIntentRouter,
  persistSagaReducerOutputThroughRuntimeAggregate,
  type RuntimeIntentProjectionRecordFor,
  type SagaRuntimeDepotLike,
  type SagaIntentWorkerHandlers,
  type SagaReducerOutput
} from '../../src/sagas';
import { SagaRuntimeAggregate } from '../../src/sagas/SagaRuntimeAggregate';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, Event[]>();

  async *readStream(id: string): AsyncIterable<Event> {
    const events = this.streams.get(id) ?? [];
    for (const event of events) {
      yield event;
    }
  }

  async saveEvents(id: string, events: Event[]): Promise<void> {
    const existing = this.streams.get(id) ?? [];
    this.streams.set(id, [...existing, ...events]);
  }

  getStream(id: string): readonly Event[] {
    return this.streams.get(id) ?? [];
  }
}

function createSubscription(events: ProjectionEvent[]): IEventSubscription {
  return {
    async poll(cursor, batchSize) {
      const batch = events
        .filter(event => event.sequence > cursor.sequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, batchSize);

      const nextCursor = batch.length > 0
        ? {
          sequence: batch[batch.length - 1].sequence,
          timestamp: batch[batch.length - 1].timestamp
        }
        : cursor;

      return {
        events: batch,
        nextCursor
      };
    }
  };
}

function makeRuntimeRecord(
  output: SagaReducerOutput<{ step: number }, BillingCommandMap>,
  sagaStreamId: string,
  dueAt: string
): RuntimeIntentProjectionRecordFor<BillingCommandMap> {
  return {
    intentKey: `${sagaStreamId}:0:test-hash`,
    sagaStreamId,
    intentType: output.intents[0].type,
    intent: output.intents[0],
    status: 'queued',
    attempts: 0,
    queuedAt: '2026-03-31T00:00:00.000Z',
    dueAt,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    lastErrorMessage: null
  };
}

describe('SagaRouterDaemon', () => {
  it('starts, emits health events, ticks, and stops cleanly', async () => {
    const processTick = jest.fn(async () => 2);
    const healthEvents: SagaRouterDaemonHealthEvent[] = [];

    let timestampOrdinal = 0;
    const daemon = new SagaRouterDaemon({
      processTick,
      pollIntervalMs: 10,
      onHealthEvent: event => healthEvents.push(event),
      createTimestamp: () => `t-${++timestampOrdinal}`
    });

    const started = daemon.start();
    await new Promise(resolve => setTimeout(resolve, 25));
    daemon.stop();
    await started;

    expect(daemon.isRunning).toBe(false);
    expect(daemon.ticksProcessed).toBeGreaterThan(0);
    expect(processTick).toHaveBeenCalledTimes(daemon.ticksProcessed);
    expect(healthEvents[0].type).toBe('started');
    expect(healthEvents[healthEvents.length - 1].type).toBe('stopped');
  });

  it('runs startup scan once before polling loop', async () => {
    let daemon: SagaRouterDaemon;
    const startupScan = jest.fn(async () => 1);
    const processTick = jest.fn(async () => {
      daemon.stop();
      return 0;
    });

    daemon = new SagaRouterDaemon({ startupScan, processTick, pollIntervalMs: 0 });
    await daemon.start();

    expect(startupScan).toHaveBeenCalledTimes(1);
    expect(processTick).toHaveBeenCalledTimes(1);
  });

  it('S30 acceptance: forced crash then restart executes pending dispatch exactly once', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;

    const output: SagaReducerOutput<{ step: number }, BillingCommandMap> = {
      state: { step: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-crash-restart', amount: 420 },
          metadata: {
            sagaId: 'saga-crash-restart',
            correlationId: 'corr-crash-restart',
            causationId: 'cause-crash-restart'
          }
        }
      ]
    };

    const sagaStreamId = 'saga-stream-crash-restart';
    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => '2026-03-31T00:00:00.000Z'
    });

    const streamEvents = store.getStream(sagaStreamId);
    const projectionEvents: ProjectionEvent[] = streamEvents.map((event, index) => ({
      aggregateType: 'sagaRuntime',
      aggregateId: sagaStreamId,
      type: event.type,
      payload: event.payload,
      sequence: index + 1,
      timestamp: new Date(Date.parse('2026-03-31T00:00:00.000Z') + index).toISOString()
    }));

    const runtimeProjectionStore = new InMemoryRuntimeIntentProjectionStore();
    const runtimeProjectionDaemon = new ProjectionDaemon({
      projection: createRuntimeIntentProjection(),
      subscription: createSubscription(projectionEvents),
      store: runtimeProjectionStore
    });
    await runtimeProjectionDaemon.processBatch();

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const runtimeStartupScan = createRuntimeStartupRecoveryScan<BillingCommandMap>(
      runtimeProjectionStore,
      runtimeDepot,
      handlers,
      {
        now: () => new Date('2026-03-31T00:00:00.000Z'),
        createTimestamp: () => '2026-03-31T00:00:00.005Z'
      }
    );

    let crashArmed = true;
    const startupScan = jest.fn(async () => {
      const processed = await runtimeStartupScan();
      if (crashArmed) {
        crashArmed = false;
        throw new Error('forced-crash');
      }

      return processed;
    });

    const crashedDaemon = new SagaRouterDaemon({ startupScan, processTick: jest.fn(async () => 0), pollIntervalMs: 0 });
    await expect(crashedDaemon.start()).rejects.toThrow('forced-crash');

    let restartedDaemon: SagaRouterDaemon;
    restartedDaemon = new SagaRouterDaemon({
      startupScan: runtimeStartupScan,
      processTick: jest.fn(async () => {
        restartedDaemon.stop();
        return 0;
      }),
      pollIntervalMs: 0
    });

    await restartedDaemon.start();

    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it('routes due timeout wake-up through worker pipeline during daemon tick', async () => {
    const projection = new InMemoryRuntimeIntentProjectionStore();
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

    const record = makeRuntimeRecord(output, 'saga-stream-daemon', '2026-03-31T00:00:00.500Z');
    (projection as any).documents.set('intent:saga-stream-daemon:0:test-hash', record);

    const typedProjection = {
      getDueIntents: (now?: string | Date) => projection.getDueIntents(now) as RuntimeIntentProjectionRecordFor<BillingCommandMap>[],
      getByIntentKey: (intentKey: string) => projection.getByIntentKey(intentKey) as RuntimeIntentProjectionRecordFor<BillingCommandMap> | null
    };

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const routeWakeUpIntent = createSagaTimeoutWakeUpIntentRouter<BillingCommandMap>(typedProjection, handlers);
    const timeoutScan = createSagaTimeoutCronScanner(typedProjection, routeWakeUpIntent, {
      now: () => '2026-03-31T00:00:00.500Z'
    });

    let daemon: SagaRouterDaemon;
    const processTick = jest.fn(async () => {
      daemon.stop();
      return 0;
    });

    daemon = new SagaRouterDaemon({ timeoutScan, processTick, pollIntervalMs: 0 });
    await daemon.start();

    expect(handlers.schedule).toHaveBeenCalledTimes(1);
    expect(processTick).toHaveBeenCalledTimes(1);
  });
});
