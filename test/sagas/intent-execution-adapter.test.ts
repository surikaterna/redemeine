import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import {
  InMemoryRuntimeIntentProjectionStore,
  createRuntimeIntentProjection,
  createRuntimeIntentProcessTick,
  createRuntimeStartupRecoveryScan,
  decideDueSagaIntentExecution,
  executeSagaIntentExecutionTicket,
  persistSagaReducerOutputThroughRuntimeAggregate,
  type SagaRuntimeDepotLike,
  type SagaRunActivityIntent,
  type SagaIntentWorkerHandlers,
  type SagaReducerOutput,
  type RuntimeIntentProjectionRecordFor
} from '../../src/sagas/internal/runtime';
import { SagaRuntimeAggregate } from '../../src/sagas/internal/runtime/SagaRuntimeAggregate';
import { ProjectionDaemon, type IEventSubscription, type ProjectionEvent } from '../../src/projections';

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
}

function createRuntimeRecordFromOutput(
  output: SagaReducerOutput<{ attempts: number }, BillingCommandMap>,
  sagaStreamId: string,
  recordedAt = '2026-03-31T00:00:00.000Z'
): RuntimeIntentProjectionRecordFor<BillingCommandMap> {
  const intent = output.intents[0];
  const intentKey = `${sagaStreamId}:0:test-hash`;

  return {
    intentKey,
    sagaStreamId,
    intentType: intent.type,
    intent,
    status: 'queued',
    attempts: 0,
    queuedAt: recordedAt,
    dueAt: recordedAt,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    lastErrorMessage: null
  };
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

describe('R7 intent decision/execution split adapters', () => {
  it('skips replayed duplicate execution after completion without duplicate side effects', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-dup', amount: 100 },
          metadata: { sagaId: 'saga-dup', correlationId: 'corr-dup', causationId: 'cause-dup' }
        }
      ]
    };

    const sagaStreamId = 'saga-runtime-dup';
    const record = createRuntimeRecordFromOutput(output, sagaStreamId);

    const runtime = await runtimeDepot.get(sagaStreamId);
    runtime.dispatch(SagaRuntimeAggregate.commandCreators.queueIntent({
      intentKey: record.intentKey,
      idempotencyKey: record.intentKey,
      metadata: record.intent.metadata,
      intentType: record.intent.type,
      intent: record.intent,
      queuedAt: record.queuedAt
    }));
    await runtimeDepot.save(runtime);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const firstTicket = await decideDueSagaIntentExecution(record, runtimeDepot);
    await expect(executeSagaIntentExecutionTicket(firstTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.010Z'
    })).resolves.toMatchObject({ executed: true, outcome: 'completed' });

    const secondTicket = await decideDueSagaIntentExecution(record, runtimeDepot);
    await expect(executeSagaIntentExecutionTicket(secondTicket, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'no-op-already-completed'
    });

    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it('schedules retry through runtime aggregate and retries without duplicate completion side effects', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;

    const activity = jest
      .fn<() => Promise<'ok'>>()
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { retryable: true }))
      .mockResolvedValue('ok');

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'run-activity',
          name: 'charge-card',
          closure: activity,
          retryPolicy: {
            maxAttempts: 2,
            initialBackoffMs: 100,
            backoffCoefficient: 2
          },
          metadata: { sagaId: 'saga-retry', correlationId: 'corr-retry', causationId: 'cause-retry' }
        }
      ]
    };

    const sagaStreamId = 'saga-runtime-retry';
    const record = createRuntimeRecordFromOutput(output, sagaStreamId);

    const runtime = await runtimeDepot.get(sagaStreamId);
    runtime.dispatch(SagaRuntimeAggregate.commandCreators.queueIntent({
      intentKey: record.intentKey,
      idempotencyKey: record.intentKey,
      metadata: record.intent.metadata,
      intentType: record.intent.type,
      intent: record.intent,
      queuedAt: record.queuedAt
    }));
    await runtimeDepot.save(runtime);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async intent => (intent as SagaRunActivityIntent).closure())
    };

    const firstTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.000Z'
    });
    await expect(executeSagaIntentExecutionTicket(firstTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.010Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const notDueTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.050Z'
    });
    await expect(executeSagaIntentExecutionTicket(notDueTicket, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'skip-not-due'
    });

    const dueTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.110Z'
    });
    await expect(executeSagaIntentExecutionTicket(dueTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.110Z'
    })).resolves.toMatchObject({ executed: true, outcome: 'completed' });

    const duplicateAfterSuccess = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:01.000Z'
    });
    await expect(executeSagaIntentExecutionTicket(duplicateAfterSuccess, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'no-op-already-completed'
    });

    expect(handlers.runActivity).toHaveBeenCalledTimes(2);
  });

  it('R10 startup recovery scans runtime due projection and executes pending intent once', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;
    const sagaStreamId = 'saga-runtime-startup-recovery';

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-recover-runtime', amount: 250 },
          metadata: { sagaId: 'saga-recover-runtime', correlationId: 'corr-recover-runtime', causationId: 'cause-recover-runtime' }
        }
      ]
    };

    const runtimeQueuedAt = '2026-03-31T00:00:00.000Z';
    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => runtimeQueuedAt
    });

    const streamEvents = (store as unknown as { streams: Map<string, Event[]> }).streams.get(sagaStreamId) ?? [];
    const projectionEvents: ProjectionEvent[] = streamEvents.map((event, index) => ({
      aggregateType: 'sagaRuntime',
      aggregateId: sagaStreamId,
      type: event.type,
      payload: event.payload,
      sequence: index + 1,
      timestamp: new Date(Date.parse(runtimeQueuedAt) + index).toISOString()
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

    const startupScan = createRuntimeStartupRecoveryScan<BillingCommandMap>(
      runtimeProjectionStore,
      runtimeDepot,
      handlers,
      {
        now: () => new Date(runtimeQueuedAt),
        createTimestamp: () => '2026-03-31T00:00:00.010Z'
      }
    );

    await expect(startupScan()).resolves.toBe(1);
    await expect(startupScan()).resolves.toBe(0);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);
  });

  it('R10 due routing executes through worker pipeline from runtime projection index', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;
    const sagaStreamId = 'saga-runtime-due-routing';

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-due-runtime', amount: 310 },
          metadata: { sagaId: 'saga-due-runtime', correlationId: 'corr-due-runtime', causationId: 'cause-due-runtime' }
        }
      ]
    };

    const runtimeQueuedAt = '2026-03-31T01:00:00.000Z';
    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => runtimeQueuedAt
    });

    const streamEvents = (store as unknown as { streams: Map<string, Event[]> }).streams.get(sagaStreamId) ?? [];
    const projectionEvents: ProjectionEvent[] = streamEvents.map((event, index) => ({
      aggregateType: 'sagaRuntime',
      aggregateId: sagaStreamId,
      type: event.type,
      payload: event.payload,
      sequence: index + 1,
      timestamp: new Date(Date.parse(runtimeQueuedAt) + index).toISOString()
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

    const processTick = createRuntimeIntentProcessTick<BillingCommandMap>(
      runtimeProjectionStore,
      runtimeDepot,
      handlers,
      {
        now: () => new Date(runtimeQueuedAt),
        createTimestamp: () => '2026-03-31T01:00:00.010Z'
      }
    );

    await expect(processTick()).resolves.toBe(1);
    await expect(processTick()).resolves.toBe(0);
    expect(handlers.dispatch).toHaveBeenCalledTimes(1);

    const updatedEvents = (store as unknown as { streams: Map<string, Event[]> }).streams.get(sagaStreamId) ?? [];
    expect(updatedEvents.some(event => event.type === 'sagaRuntime.intentCompleted.event')).toBe(true);
  });
});
