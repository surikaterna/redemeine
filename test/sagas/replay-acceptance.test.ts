import { describe, expect, it, jest } from '@jest/globals';
import type { SagaReducerOutput } from '../../src/sagas';
import {
  InMemorySagaEventStore,
  appendSagaIntentSucceededEvent,
  createSagaIntentRecordedEvents,
  decideIntentExecutionFromEventStore,
  executeSagaReducerOutputInReplay
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S28 acceptance: replay does not re-run external side effects', () => {
  it('replay from event one executes external activity zero additional times', async () => {
    const store = new InMemorySagaEventStore();
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

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-1', output, () => '2026-03-31T00:00:00.000Z');
    await store.appendIntentRecordedBatch('saga-stream-1', [recorded]);

    if (recorded.intent.type !== 'run-activity') {
      throw new Error('Expected run-activity intent for S28 acceptance test setup.');
    }

    const initialDecision = await decideIntentExecutionFromEventStore(
      store,
      'saga-stream-1',
      recorded.idempotencyKey
    );
    expect(initialDecision).toEqual({ shouldExecute: true, reason: 'execute' });

    await recorded.intent.closure();
    expect(activity).toHaveBeenCalledTimes(1);

    await appendSagaIntentSucceededEvent(
      store,
      {
        sagaStreamId: 'saga-stream-1',
        intentKey: recorded.idempotencyKey,
        metadata: recorded.intent.metadata
      },
      () => '2026-03-31T00:00:00.010Z'
    );

    const replayDecision = await decideIntentExecutionFromEventStore(
      store,
      'saga-stream-1',
      recorded.idempotencyKey
    );
    expect(replayDecision).toEqual({
      shouldExecute: false,
      reason: 'no-op-already-succeeded'
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
