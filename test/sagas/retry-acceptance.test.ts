import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import type { SagaReducerOutput } from '../../src/sagas';
import {
  PendingIntentProjection,
  createSagaIntentRecordedEvents,
  decideDueSagaIntentExecution,
  executeSagaIntentExecutionTicket,
  persistSagaReducerOutputThroughRuntimeAggregate,
  type SagaRuntimeDepotLike,
  type SagaRunActivityIntent,
  type SagaIntentWorkerHandlers
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

describe('S29 acceptance: transient failures eventually succeed with configured backoff', () => {
  it('retries a failing activity three times, then succeeds on the fourth attempt', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;
    const projection = new PendingIntentProjection<BillingCommandMap>();

    const retryPolicy = {
      maxAttempts: 4,
      initialBackoffMs: 100,
      backoffCoefficient: 2
    } as const;

    const activity = jest
      .fn<() => Promise<'ok'>>()
      .mockRejectedValueOnce(Object.assign(new Error('transient-1'), { retryable: true }))
      .mockRejectedValueOnce(Object.assign(new Error('transient-2'), { retryable: true }))
      .mockRejectedValueOnce(Object.assign(new Error('transient-3'), { retryable: true }))
      .mockResolvedValue('ok');

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 0 },
      intents: [
        {
          type: 'run-activity',
          name: 'charge-card',
          closure: activity,
          retryPolicy,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        }
      ]
    };

    const sagaStreamId = 'saga-stream-1';
    const [recorded] = createSagaIntentRecordedEvents(sagaStreamId, output, () => '2026-03-31T00:00:00.000Z');
    if (recorded.intent.type !== 'run-activity') {
      throw new Error('Expected run-activity intent for S29 acceptance test setup.');
    }

    projection.projectEvents([recorded], []);

    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => recorded.recordedAt
    });

    const record = projection.getByIntentKey(recorded.idempotencyKey);
    if (!record) {
      throw new Error('Expected pending intent record for retry acceptance setup.');
    }

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

    const beforeSecondDue = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.109Z'
    });
    await expect(executeSagaIntentExecutionTicket(beforeSecondDue, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'skip-not-due'
    });

    const secondTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.110Z'
    });
    await expect(executeSagaIntentExecutionTicket(secondTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.110Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const thirdTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.320Z'
    });
    await expect(executeSagaIntentExecutionTicket(thirdTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.320Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const fourthTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.730Z'
    });
    await expect(executeSagaIntentExecutionTicket(fourthTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.730Z'
    })).resolves.toMatchObject({ executed: true, outcome: 'completed' });

    expect(activity).toHaveBeenCalledTimes(4);

    const runtimeEvents = store.getStream(sagaStreamId);
    expect(runtimeEvents.map(event => event.type)).toEqual([
      'sagaRuntime.intentQueued.event',
      'sagaRuntime.intentStarted.event',
      'sagaRuntime.intentFailed.event',
      'sagaRuntime.intentRetryScheduled.event',
      'sagaRuntime.intentStarted.event',
      'sagaRuntime.intentFailed.event',
      'sagaRuntime.intentRetryScheduled.event',
      'sagaRuntime.intentStarted.event',
      'sagaRuntime.intentFailed.event',
      'sagaRuntime.intentRetryScheduled.event',
      'sagaRuntime.intentStarted.event',
      'sagaRuntime.intentCompleted.event'
    ]);
  });
});
