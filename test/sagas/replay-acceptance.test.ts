import { describe, expect, it, jest } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import type { SagaReducerOutput, SagaIntentWorkerHandlers, SagaRuntimeDepotLike } from '../../src/sagas';
import {
  PendingIntentProjection,
  createSagaIntentRecordedEvents,
  decideDueSagaIntentExecution,
  executeSagaIntentExecutionTicket,
  executeSagaReducerOutputInReplay,
  persistSagaReducerOutputThroughRuntimeAggregate
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

describe('S28 acceptance: replay does not re-run external side effects', () => {
  it('replay from event one executes external activity zero additional times', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;
    const activity = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const output: SagaReducerOutput<{ step: number }, BillingCommandMap> = {
      state: { step: 1 },
      intents: [
        {
          type: 'run-activity',
          name: 'charge-card',
          closure: activity,
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
    const pendingProjection = new PendingIntentProjection<BillingCommandMap>();
    pendingProjection.projectEvents([recorded], []);

    await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
      sagaStreamId,
      createQueuedAt: () => recorded.recordedAt
    });

    if (recorded.intent.type !== 'run-activity') {
      throw new Error('Expected run-activity intent for S28 acceptance test setup.');
    }

    const record = pendingProjection.getByIntentKey(recorded.idempotencyKey);
    if (!record) {
      throw new Error('Expected pending record for replay acceptance setup.');
    }

    const handlers: SagaIntentWorkerHandlers<BillingCommandMap> = {
      dispatch: jest.fn(async () => undefined),
      schedule: jest.fn(async () => undefined),
      cancelSchedule: jest.fn(async () => undefined),
      runActivity: jest.fn(async () => activity())
    };

    const firstTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.000Z'
    });
    await expect(executeSagaIntentExecutionTicket(firstTicket, runtimeDepot, handlers, {
      createTimestamp: () => '2026-03-31T00:00:00.010Z'
    })).resolves.toMatchObject({ executed: true, outcome: 'completed' });

    const replayTicket = await decideDueSagaIntentExecution(record, runtimeDepot, {
      now: () => '2026-03-31T00:00:00.020Z'
    });
    await expect(executeSagaIntentExecutionTicket(replayTicket, runtimeDepot, handlers)).resolves.toMatchObject({
      executed: false,
      outcome: 'skipped',
      reason: 'no-op-already-completed'
    });

    const replayResult = await executeSagaReducerOutputInReplay(output, {
      runActivity: jest.fn()
    });

    expect(replayResult.outcomes).toEqual([
      {
        intentType: 'run-activity',
        executed: false,
        reason: 'replay-mode-suppressed'
      }
    ]);
    expect(activity).toHaveBeenCalledTimes(1);
  });
});
