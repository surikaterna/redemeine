import { describe, expect, it, jest } from '@jest/globals';
import type {
  SagaIntentWorkerHandlers,
  SagaReducerOutput,
  SagaRuntimeDepotLike
} from '../../src/sagas/internal/runtime';
import {
  InMemoryRuntimeIntentProjectionStore,
  SagaRouterDaemon,
  createRuntimeIntentProcessTick,
  createRuntimeIntentProjection,
  persistSagaReducerOutputThroughRuntimeAggregate,
  SagaRuntimeAggregate
} from '../../src/sagas/internal/runtime';
import { ProjectionDaemon } from '../../src/projections';
import { createDepot } from '../../src/Depot';
import type { Event } from '../../src/types';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S32 acceptance: due timeout routes wake-up and drives expected transition', () => {
  class InMemoryEventStore {
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

  it('routes due schedule intent once through runtime execution path', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;

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

    const sagaStreamId = 'saga-stream-timeout-acceptance';
    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => '2026-03-31T00:00:00.000Z'
    });

    const streamEvents = store.getStream(sagaStreamId);
    const projectionEvents = streamEvents.map((event, index) => ({
      aggregateType: 'sagaRuntime' as const,
      aggregateId: sagaStreamId,
      type: event.type,
      payload: event.payload,
      sequence: index + 1,
      timestamp: new Date(Date.parse('2026-03-31T00:00:00.000Z') + index).toISOString()
    }));

    const projection = new InMemoryRuntimeIntentProjectionStore();
    const projectionDaemon = new ProjectionDaemon({
      projection: createRuntimeIntentProjection(),
      subscription: {
        async poll(cursor, batchSize) {
          const batch = projectionEvents
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
      },
      store: projection
    });
    await projectionDaemon.processBatch();

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

    const processTick = createRuntimeIntentProcessTick<BillingCommandMap>(
      projection,
      runtimeDepot,
      handlers,
      {
        now: () => '2026-03-31T00:00:00.500Z',
        createTimestamp: () => '2026-03-31T00:00:00.501Z'
      }
    );

    let daemon: SagaRouterDaemon;
    const daemonTick = jest.fn(async () => {
      const processed = await processTick();
      daemon.stop();
      return processed;
    });

    daemon = new SagaRouterDaemon({
      processTick: daemonTick,
      pollIntervalMs: 0
    });

    await daemon.start();

    expect(handlers.schedule).toHaveBeenCalledTimes(1);
    expect(daemonTick).toHaveBeenCalledTimes(1);
    expect(sagaRuntimeState).toEqual({
      phase: 'timed-out',
      wakeUps: 1
    });
    expect(daemon.ticksProcessed).toBe(1);
  });
});
