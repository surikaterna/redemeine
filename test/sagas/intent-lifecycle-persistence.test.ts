import { describe, expect, it } from '@jest/globals';
import {
  InMemorySagaEventStore,
  appendSagaIntentDispatchedEvent,
  appendSagaIntentFailedEvent,
  appendSagaIntentRetryScheduledEventFromPolicy,
  appendSagaIntentStartedEvent,
  appendSagaIntentSucceededEvent
} from '../../src/sagas';

describe('S10 intent lifecycle persistence', () => {
  it('writes started/dispatched/succeeded/failed lifecycle events with timestamps', async () => {
    const store = new InMemorySagaEventStore();

    const input = {
      sagaStreamId: 'saga-stream-1',
      intentKey: 'intent-1',
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    };

    await appendSagaIntentStartedEvent(store, input, () => '2026-03-30T00:00:01.000Z');
    await appendSagaIntentDispatchedEvent(store, input, () => '2026-03-30T00:00:01.500Z');
    await appendSagaIntentSucceededEvent(store, input, () => '2026-03-30T00:00:02.000Z');
    await appendSagaIntentFailedEvent(store, input, () => '2026-03-30T00:00:03.000Z');

    const lifecycleEvents = await store.loadLifecycleEvents('saga-stream-1');

    expect(lifecycleEvents).toEqual([
      {
        type: 'saga.intent-started',
        sagaStreamId: 'saga-stream-1',
        lifecycle: {
          intentKey: 'intent-1',
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        startedAt: '2026-03-30T00:00:01.000Z'
      },
      {
        type: 'saga.intent-dispatched',
        sagaStreamId: 'saga-stream-1',
        lifecycle: {
          intentKey: 'intent-1',
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        dispatchedAt: '2026-03-30T00:00:01.500Z'
      },
      {
        type: 'saga.intent-succeeded',
        sagaStreamId: 'saga-stream-1',
        lifecycle: {
          intentKey: 'intent-1',
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        succeededAt: '2026-03-30T00:00:02.000Z'
      },
      {
        type: 'saga.intent-failed',
        sagaStreamId: 'saga-stream-1',
        lifecycle: {
          intentKey: 'intent-1',
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        failedAt: '2026-03-30T00:00:03.000Z'
      }
    ]);
  });

  it('persists retry attempt metadata with computed nextAttemptAt', async () => {
    const store = new InMemorySagaEventStore();

    const input = {
      sagaStreamId: 'saga-stream-1',
      intentKey: 'intent-1',
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      },
      policy: {
        maxAttempts: 5,
        initialBackoffMs: 1_000,
        backoffCoefficient: 2,
        maxBackoffMs: 10_000,
        jitterCoefficient: 0.2
      },
      attempt: 3,
      now: '2026-03-31T00:00:00.000Z' as const,
      jitter: 0.5
    };

    await appendSagaIntentRetryScheduledEventFromPolicy(store, input, () => '2026-03-31T00:00:00.001Z');

    const lifecycleEvents = await store.loadLifecycleEvents('saga-stream-1');

    expect(lifecycleEvents).toEqual([
      {
        type: 'saga.intent-retry-scheduled',
        sagaStreamId: 'saga-stream-1',
        lifecycle: {
          intentKey: 'intent-1',
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        retry: {
          attempt: 3,
          nextAttemptAt: '2026-03-31T00:00:04.000Z'
        },
        scheduledAt: '2026-03-31T00:00:00.001Z'
      }
    ]);
  });
});
