import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import type { SagaReducerOutput } from '../../src/sagas';
import {
  decideDueSagaIntentExecution,
  executeSagaIntentExecutionTicket,
  persistSagaReducerOutputThroughRuntimeAggregate,
  type RuntimeIntentProjectionRecordFor,
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
    const intent = output.intents[0];
    if (intent.type !== 'run-activity') {
      throw new Error('Expected run-activity intent for S29 acceptance test setup.');
    }

    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => '2026-03-31T00:00:00.000Z'
    });

    const queuedEvent = store.getStream(sagaStreamId)[0];
    const intentKey = (queuedEvent?.payload as { intentKey?: string } | undefined)?.intentKey;
    if (!intentKey) {
      throw new Error('Expected queued runtime event with intentKey for retry acceptance setup.');
    }

    const record: RuntimeIntentProjectionRecordFor<BillingCommandMap> = {
      intentKey,
      sagaStreamId,
      intentType: intent.type,
      intent,
      status: 'queued' as const,
      attempts: 0,
      queuedAt: '2026-03-31T00:00:00.000Z',
      dueAt: '2026-03-31T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      deadLetteredAt: null,
      lastErrorMessage: null
    };

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async intent => (intent as SagaRunActivityIntent).closure())
    };

    const firstTicket = await decideDueSagaIntentExecution<BillingCommandMap>(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.000Z'
    });
    await expect(executeSagaIntentExecutionTicket(firstTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.010Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const beforeSecondDue = await decideDueSagaIntentExecution<BillingCommandMap>(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.109Z'
    });
    await expect(executeSagaIntentExecutionTicket(beforeSecondDue, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'skip-not-due'
    });

    const secondTicket = await decideDueSagaIntentExecution<BillingCommandMap>(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.110Z'
    });
    await expect(executeSagaIntentExecutionTicket(secondTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.110Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const thirdTicket = await decideDueSagaIntentExecution<BillingCommandMap>(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.320Z'
    });
    await expect(executeSagaIntentExecutionTicket(thirdTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.320Z',
      retryJitter: 0.5
    })).resolves.toMatchObject({ executed: true, outcome: 'retry-scheduled' });

    const fourthTicket = await decideDueSagaIntentExecution<BillingCommandMap>(record, runtimeDepot, {
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
