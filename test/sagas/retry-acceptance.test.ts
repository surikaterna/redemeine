import { describe, expect, it, jest } from '@jest/globals';
import type { SagaReducerOutput } from '../../src/sagas';
import {
  InMemorySagaEventStore,
  PendingIntentProjection,
  appendSagaIntentFailedEvent,
  appendSagaIntentRetryScheduledEventFromPolicy,
  appendSagaIntentStartedEvent,
  appendSagaIntentSucceededEvent,
  createSagaIntentRecordedEvents
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S29 acceptance: transient failures eventually succeed with configured backoff', () => {
  it('retries a failing activity three times, then succeeds on the fourth attempt', async () => {
    const store = new InMemorySagaEventStore();
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

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-1', output, () => '2026-03-31T00:00:00.000Z');
    if (recorded.intent.type !== 'run-activity') {
      throw new Error('Expected run-activity intent for S29 acceptance test setup.');
    }
    const recordedActivityIntent = recorded.intent;

    await store.appendIntentRecordedBatch('saga-stream-1', [recorded]);
    projection.projectEvents([recorded], []);

    let failures = 0;

    const executeDueAttempt = async (startedAt: string): Promise<void> => {
      const [pending] = projection.getExecutablePendingIntents(startedAt);
      expect(pending).toBeDefined();

      if (!pending || pending.intent.type !== 'run-activity') {
        throw new Error('Expected due run-activity intent during retry acceptance execution.');
      }

      const started = await appendSagaIntentStartedEvent(
        store,
        {
          sagaStreamId: 'saga-stream-1',
          intentKey: recorded.idempotencyKey,
          metadata: recorded.intent.metadata
        },
        () => startedAt
      );
      projection.projectLifecycleEvent(started);

      try {
        await pending.intent.closure();

        const succeeded = await appendSagaIntentSucceededEvent(
          store,
          {
            sagaStreamId: 'saga-stream-1',
            intentKey: recorded.idempotencyKey,
            metadata: recorded.intent.metadata
          },
          () => new Date(Date.parse(startedAt) + 10).toISOString()
        );
        projection.projectLifecycleEvent(succeeded);
      } catch (error) {
        const failedAt = new Date(Date.parse(startedAt) + 10).toISOString();
        const failed = await appendSagaIntentFailedEvent(
          store,
          {
            sagaStreamId: 'saga-stream-1',
            intentKey: recorded.idempotencyKey,
            metadata: recorded.intent.metadata
          },
          () => failedAt
        );
        projection.projectLifecycleEvent(failed);

        failures += 1;
        if (recordedActivityIntent.retryPolicy && failures < recordedActivityIntent.retryPolicy.maxAttempts) {
          const retryScheduled = await appendSagaIntentRetryScheduledEventFromPolicy(
            store,
            {
              sagaStreamId: 'saga-stream-1',
              intentKey: recorded.idempotencyKey,
              metadata: recorded.intent.metadata,
              policy: recordedActivityIntent.retryPolicy,
              attempt: failures,
              now: failedAt,
              jitter: 0.5
            },
            () => failedAt
          );
          projection.projectLifecycleEvent(retryScheduled);
        } else {
          throw error;
        }
      }
    };

    await executeDueAttempt('2026-03-31T00:00:00.000Z');
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.109Z')).toHaveLength(0);
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.110Z')).toHaveLength(1);

    await executeDueAttempt('2026-03-31T00:00:00.110Z');
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.319Z')).toHaveLength(0);
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.320Z')).toHaveLength(1);

    await executeDueAttempt('2026-03-31T00:00:00.320Z');
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.729Z')).toHaveLength(0);
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:00.730Z')).toHaveLength(1);

    await executeDueAttempt('2026-03-31T00:00:00.730Z');

    const finalRecord = projection.getByIntentKey(recorded.idempotencyKey);
    expect(finalRecord?.status).toBe('succeeded');
    expect(projection.getExecutablePendingIntents('2026-03-31T00:00:10.000Z')).toHaveLength(0);
    expect(activity).toHaveBeenCalledTimes(4);

    const lifecycleEvents = await store.loadLifecycleEvents('saga-stream-1');
    expect(lifecycleEvents.map(event => event.type)).toEqual([
      'saga.intent-started',
      'saga.intent-failed',
      'saga.intent-retry-scheduled',
      'saga.intent-started',
      'saga.intent-failed',
      'saga.intent-retry-scheduled',
      'saga.intent-started',
      'saga.intent-failed',
      'saga.intent-retry-scheduled',
      'saga.intent-started',
      'saga.intent-succeeded'
    ]);
  });
});
