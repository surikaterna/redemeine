import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import {
  PendingIntentProjection,
  createSagaIntentRecordedEvents,
  decideDueSagaIntentExecution,
  executeSagaIntentExecutionTicket,
  type SagaRuntimeDepotLike,
  type SagaRunActivityIntent,
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
}

function createPendingProjection(
  output: SagaReducerOutput<{ attempts: number }, BillingCommandMap>,
  sagaStreamId: string,
  recordedAt = '2026-03-31T00:00:00.000Z'
): PendingIntentProjection<BillingCommandMap> {
  const projection = new PendingIntentProjection<BillingCommandMap>();
  const [recorded] = createSagaIntentRecordedEvents(sagaStreamId, output, () => recordedAt);
  projection.projectEvents([recorded], []);
  return projection;
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
    const projection = createPendingProjection(output, sagaStreamId);
    const [recorded] = createSagaIntentRecordedEvents(sagaStreamId, output, () => '2026-03-31T00:00:00.000Z');

    const runtime = await runtimeDepot.get(sagaStreamId);
    runtime.dispatch(SagaRuntimeAggregate.commandCreators.queueIntent({
      intentKey: recorded.idempotencyKey,
      idempotencyKey: recorded.idempotencyKey,
      metadata: recorded.intent.metadata,
      intentType: recorded.intent.type,
      queuedAt: recorded.recordedAt
    }));
    await runtimeDepot.save(runtime);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => undefined)
    };

    const record = projection.getByIntentKey(recorded.idempotencyKey);
    if (!record) {
      throw new Error('Expected pending record for duplicate execution test setup.');
    }

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
    const projection = createPendingProjection(output, sagaStreamId);
    const [recorded] = createSagaIntentRecordedEvents(sagaStreamId, output, () => '2026-03-31T00:00:00.000Z');

    const runtime = await runtimeDepot.get(sagaStreamId);
    runtime.dispatch(SagaRuntimeAggregate.commandCreators.queueIntent({
      intentKey: recorded.idempotencyKey,
      idempotencyKey: recorded.idempotencyKey,
      metadata: recorded.intent.metadata,
      intentType: recorded.intent.type,
      queuedAt: recorded.recordedAt
    }));
    await runtimeDepot.save(runtime);

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async intent => (intent as SagaRunActivityIntent).closure())
    };

    const record = projection.getByIntentKey(recorded.idempotencyKey);
    if (!record) {
      throw new Error('Expected pending record for retry execution test setup.');
    }

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
});
