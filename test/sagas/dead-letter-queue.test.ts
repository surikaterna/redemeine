import { describe, expect, it } from '@jest/globals';
import {
  InMemorySagaEventStore,
  PendingIntentProjection,
  appendSagaIntentFailureOutcomeEvent,
  createSagaIntentRecordedEvents,
  queryDeadLetterEvents,
  type SagaReducerOutput
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S25 acceptance: terminal failures emit DLQ lifecycle events', () => {
  const baseOutput: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
    state: { attempts: 0 },
    intents: [
      {
        type: 'run-activity',
        name: 'charge-card',
        closure: async () => 'ok',
        retryPolicy: {
          maxAttempts: 3,
          initialBackoffMs: 100,
          backoffCoefficient: 2
        },
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-1'
        }
      }
    ]
  };

  it('dead-letters non-retryable failures with failure context', async () => {
    const store = new InMemorySagaEventStore();
    const projection = new PendingIntentProjection<BillingCommandMap>();
    const [recorded] = createSagaIntentRecordedEvents('saga-stream-1', baseOutput, () => '2026-03-31T00:00:00.000Z');

    await store.appendIntentRecordedBatch('saga-stream-1', [recorded]);
    projection.projectEvents([recorded], []);

    const error = Object.assign(new Error('validation failed'), { status: 422, code: 'VALIDATION' });

    const outcome = await appendSagaIntentFailureOutcomeEvent(
      store,
      {
        sagaStreamId: 'saga-stream-1',
        intentKey: recorded.idempotencyKey,
        metadata: recorded.intent.metadata,
        error,
        attempt: 1,
        policy: recorded.intent.type === 'run-activity' ? recorded.intent.retryPolicy : undefined,
        now: '2026-03-31T00:00:00.010Z'
      },
      () => '2026-03-31T00:00:00.010Z'
    );

    projection.projectLifecycleEvent(outcome);

    expect(outcome.type).toBe('saga.intent-dead-lettered');
    if (outcome.type !== 'saga.intent-dead-lettered') {
      throw new Error('Expected dead-lettered outcome');
    }

    expect(outcome.deadLetter).toEqual({
      attempt: 1,
      classification: 'non-retryable',
      reason: 'non-retryable',
      error: {
        name: 'Error',
        message: 'validation failed',
        code: 'VALIDATION',
        status: 422
      }
    });

    const projected = projection.getByIntentKey(recorded.idempotencyKey);
    expect(projected?.status).toBe('failed');
    expect(projected?.failedAt).toBe('2026-03-31T00:00:00.010Z');
  });

  it('dead-letters retryable failures when max attempts are exhausted', async () => {
    const store = new InMemorySagaEventStore();
    const [recorded] = createSagaIntentRecordedEvents('saga-stream-2', baseOutput, () => '2026-03-31T00:00:00.000Z');
    const retryPolicy = recorded.intent.type === 'run-activity' ? recorded.intent.retryPolicy : undefined;

    const error = Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT', status: 503 });

    const outcome = await appendSagaIntentFailureOutcomeEvent(
      store,
      {
        sagaStreamId: 'saga-stream-2',
        intentKey: recorded.idempotencyKey,
        metadata: recorded.intent.metadata,
        error,
        attempt: retryPolicy?.maxAttempts ?? 3,
        policy: retryPolicy,
        now: '2026-03-31T00:00:05.000Z'
      },
      () => '2026-03-31T00:00:05.000Z'
    );

    expect(outcome.type).toBe('saga.intent-dead-lettered');
    if (outcome.type !== 'saga.intent-dead-lettered') {
      throw new Error('Expected dead-lettered outcome');
    }

    expect(outcome.deadLetter.classification).toBe('retryable');
    expect(outcome.deadLetter.reason).toBe('max-attempts-exhausted');
    expect(outcome.deadLetter.attempt).toBe(3);
    expect(outcome.deadLetter.error.message).toBe('upstream timeout');
  });
});

describe('S26 acceptance: DLQ inspection query path', () => {
  it('lists dead-letter entries filtered by saga identifier', async () => {
    const store = new InMemorySagaEventStore();

    await store.appendLifecycleEvent('stream-a', {
      type: 'saga.intent-dead-lettered',
      sagaStreamId: 'stream-a',
      lifecycle: {
        intentKey: 'intent-a1',
        metadata: {
          sagaId: 'saga-A',
          correlationId: 'corr-a1',
          causationId: 'cause-a1'
        }
      },
      deadLetter: {
        attempt: 1,
        classification: 'non-retryable',
        reason: 'non-retryable',
        error: {
          message: 'validation failed'
        }
      },
      deadLetteredAt: '2026-03-31T00:00:01.000Z'
    });

    await store.appendLifecycleEvent('stream-b', {
      type: 'saga.intent-dead-lettered',
      sagaStreamId: 'stream-b',
      lifecycle: {
        intentKey: 'intent-b1',
        metadata: {
          sagaId: 'saga-B',
          correlationId: 'corr-b1',
          causationId: 'cause-b1'
        }
      },
      deadLetter: {
        attempt: 2,
        classification: 'retryable',
        reason: 'max-attempts-exhausted',
        error: {
          message: 'timeout'
        }
      },
      deadLetteredAt: '2026-03-31T00:00:02.000Z'
    });

    await store.appendLifecycleEvent('stream-a', {
      type: 'saga.intent-dead-lettered',
      sagaStreamId: 'stream-a',
      lifecycle: {
        intentKey: 'intent-a2',
        metadata: {
          sagaId: 'saga-A',
          correlationId: 'corr-a2',
          causationId: 'cause-a2'
        }
      },
      deadLetter: {
        attempt: 3,
        classification: 'retryable',
        reason: 'max-attempts-exhausted',
        error: {
          message: 'network down'
        }
      },
      deadLetteredAt: '2026-03-31T00:00:03.000Z'
    });

    const sagaAEntries = await store.loadDeadLetteredEvents({ sagaId: 'saga-A' });

    expect(sagaAEntries).toHaveLength(2);
    expect(sagaAEntries.map(entry => entry.lifecycle.intentKey)).toEqual(['intent-a1', 'intent-a2']);
    expect(sagaAEntries.every(entry => entry.lifecycle.metadata.sagaId === 'saga-A')).toBe(true);
  });

  it('lists dead-letter entries filtered by intent identifier', () => {
    const lifecycleEvents = [
      {
        type: 'saga.intent-dead-lettered' as const,
        sagaStreamId: 'stream-a',
        lifecycle: {
          intentKey: 'intent-target',
          metadata: {
            sagaId: 'saga-A',
            correlationId: 'corr-a',
            causationId: 'cause-a'
          }
        },
        deadLetter: {
          attempt: 1,
          classification: 'non-retryable' as const,
          reason: 'non-retryable' as const,
          error: {
            message: 'bad request'
          }
        },
        deadLetteredAt: '2026-03-31T00:00:10.000Z'
      },
      {
        type: 'saga.intent-failed' as const,
        sagaStreamId: 'stream-a',
        lifecycle: {
          intentKey: 'intent-other',
          metadata: {
            sagaId: 'saga-A',
            correlationId: 'corr-b',
            causationId: 'cause-b'
          }
        },
        failedAt: '2026-03-31T00:00:11.000Z'
      },
      {
        type: 'saga.intent-dead-lettered' as const,
        sagaStreamId: 'stream-b',
        lifecycle: {
          intentKey: 'intent-other',
          metadata: {
            sagaId: 'saga-B',
            correlationId: 'corr-c',
            causationId: 'cause-c'
          }
        },
        deadLetter: {
          attempt: 2,
          classification: 'retryable' as const,
          reason: 'max-attempts-exhausted' as const,
          error: {
            message: 'gateway timeout'
          }
        },
        deadLetteredAt: '2026-03-31T00:00:12.000Z'
      }
    ];

    const filtered = queryDeadLetterEvents(lifecycleEvents, { intentKey: 'intent-target' });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].lifecycle.intentKey).toBe('intent-target');
    expect(filtered[0].lifecycle.metadata.sagaId).toBe('saga-A');
  });
});
