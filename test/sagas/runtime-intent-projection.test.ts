import { describe, expect, it } from '@jest/globals';
import { ProjectionDaemon, type IEventSubscription, type ProjectionEvent } from '../../src/projections';
import {
  InMemoryRuntimeIntentProjectionStore,
  createRuntimeIntentProjection,
  type RuntimeIntentProjectionRecord
} from '../../src/sagas';

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

function byIntentKey(records: RuntimeIntentProjectionRecord[]): string[] {
  return records.map(record => record.intentKey);
}

describe('R8 runtime pending/due projection', () => {
  it('indexes pending and due intents from runtime aggregate stream with attempts + dueAt', async () => {
    const events: ProjectionEvent[] = [
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentQueued.event',
        sequence: 1,
        timestamp: '2026-03-31T10:00:00.000Z',
        payload: {
          intentKey: 'intent-1',
          intentType: 'dispatch',
          intent: {
            type: 'dispatch',
            command: 'billing.charge',
            payload: { invoiceId: 'inv-1', amount: 250 },
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-1'
            }
          },
          queuedAt: '2026-03-31T10:00:00.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentStarted.event',
        sequence: 2,
        timestamp: '2026-03-31T10:00:01.000Z',
        payload: {
          intentKey: 'intent-1',
          startedAt: '2026-03-31T10:00:01.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentFailed.event',
        sequence: 3,
        timestamp: '2026-03-31T10:00:02.000Z',
        payload: {
          intentKey: 'intent-1',
          failedAt: '2026-03-31T10:00:02.000Z',
          errorMessage: 'temporary outage'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentRetryScheduled.event',
        sequence: 4,
        timestamp: '2026-03-31T10:00:03.000Z',
        payload: {
          intentKey: 'intent-1',
          attempt: 1,
          nextAttemptAt: '2026-03-31T10:05:00.000Z',
          scheduledAt: '2026-03-31T10:00:03.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentQueued.event',
        sequence: 5,
        timestamp: '2026-03-31T10:00:04.000Z',
        payload: {
          intentKey: 'intent-2',
          intentType: 'schedule',
          intent: {
            type: 'schedule',
            id: 'timer-1',
            delay: 500,
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-2'
            }
          },
          queuedAt: '2026-03-31T10:00:04.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-1',
        type: 'sagaRuntime.intentStarted.event',
        sequence: 6,
        timestamp: '2026-03-31T10:00:05.000Z',
        payload: {
          intentKey: 'intent-2',
          startedAt: '2026-03-31T10:00:05.000Z'
        }
      }
    ];

    const store = new InMemoryRuntimeIntentProjectionStore();
    const daemon = new ProjectionDaemon({
      projection: createRuntimeIntentProjection(),
      subscription: createSubscription(events),
      store
    });

    await daemon.processBatch();

    const pending = store.getPendingIntents();
    expect(byIntentKey(pending)).toEqual(['intent-1']);
    expect(pending[0]).toMatchObject({
      intentKey: 'intent-1',
      sagaStreamId: 'saga-stream-1',
      status: 'retry_scheduled',
      attempts: 1,
      dueAt: '2026-03-31T10:05:00.000Z',
      nextAttemptAt: '2026-03-31T10:05:00.000Z'
    });

    const dueAtStart = store.getDueIntents('2026-03-31T10:00:04.000Z');
    expect(dueAtStart).toHaveLength(0);

    const dueAtRetry = store.getDueIntents('2026-03-31T10:05:00.000Z');
    expect(byIntentKey(dueAtRetry)).toEqual(['intent-1']);
  });

  it('keeps runtime aggregate stream as source of truth for terminal outcomes', async () => {
    const events: ProjectionEvent[] = [
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-2',
        type: 'sagaRuntime.intentQueued.event',
        sequence: 1,
        timestamp: '2026-03-31T11:00:00.000Z',
        payload: {
          intentKey: 'intent-dead',
          intentType: 'dispatch',
          intent: {
            type: 'dispatch',
            command: 'billing.charge',
            payload: { invoiceId: 'inv-dead', amount: 111 },
            metadata: {
              sagaId: 'saga-2',
              correlationId: 'corr-2',
              causationId: 'cause-2'
            }
          },
          queuedAt: '2026-03-31T11:00:00.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-2',
        type: 'sagaRuntime.intentStarted.event',
        sequence: 2,
        timestamp: '2026-03-31T11:00:01.000Z',
        payload: {
          intentKey: 'intent-dead',
          startedAt: '2026-03-31T11:00:01.000Z'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-2',
        type: 'sagaRuntime.intentFailed.event',
        sequence: 3,
        timestamp: '2026-03-31T11:00:02.000Z',
        payload: {
          intentKey: 'intent-dead',
          failedAt: '2026-03-31T11:00:02.000Z',
          errorMessage: 'fatal'
        }
      },
      {
        aggregateType: 'sagaRuntime',
        aggregateId: 'saga-stream-2',
        type: 'sagaRuntime.intentDeadLettered.event',
        sequence: 4,
        timestamp: '2026-03-31T11:00:03.000Z',
        payload: {
          intentKey: 'intent-dead',
          attempt: 1,
          reason: 'non-retryable',
          errorMessage: 'fatal',
          deadLetteredAt: '2026-03-31T11:00:03.000Z'
        }
      }
    ];

    const store = new InMemoryRuntimeIntentProjectionStore();
    const daemon = new ProjectionDaemon({
      projection: createRuntimeIntentProjection(),
      subscription: createSubscription(events),
      store
    });

    await daemon.processBatch();

    const record = store.getByIntentKey('intent-dead');
    expect(record).toMatchObject({
      intentKey: 'intent-dead',
      status: 'dead_lettered',
      attempts: 1,
      deadLetteredAt: '2026-03-31T11:00:03.000Z',
      lastErrorMessage: 'fatal'
    });

    expect(store.getPendingIntents()).toHaveLength(0);
    expect(store.getDueIntents('2026-03-31T12:00:00.000Z')).toHaveLength(0);
  });
});
