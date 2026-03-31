import { describe, expect, it } from '@jest/globals';
import {
  InMemorySagaEventStore,
  appendSagaIntentFailedEvent,
  appendSagaIntentStartedEvent,
  appendSagaIntentSucceededEvent
} from '../../src/sagas';

describe('S10 intent lifecycle persistence', () => {
  it('writes started/succeeded/failed lifecycle events with timestamps', async () => {
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
});
