import { describe, expect, it } from '@jest/globals';
import {
  InMemorySagaRuntimeEventBuffer,
  createSagaIntentIdempotencyKey,
  type SagaReducerOutput,
  persistSagaReducerOutputIntents
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S09 intent recorded persistence', () => {
  it('persists reducer output intents as saga.intent-recorded events', async () => {
    const store = new InMemorySagaRuntimeEventBuffer();
    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-1', amount: 250 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        }
      ]
    };

    await persistSagaReducerOutputIntents('saga-stream-1', output, store, () => '2026-03-30T00:00:00.000Z');

    const recorded = await store.loadIntentRecordedEvents('saga-stream-1');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      type: 'saga.intent-recorded',
      sagaStreamId: 'saga-stream-1',
      idempotencyKey: createSagaIntentIdempotencyKey('saga-stream-1', 0, output.intents[0]),
      intent: output.intents[0],
      recordedAt: '2026-03-30T00:00:00.000Z'
    });
  });

  it('appends all intents in a single atomic batch call', async () => {
    const appendCalls: Array<{ sagaStreamId: string; size: number }> = [];

    const store = {
      appendIntentRecordedBatch: async (sagaStreamId: string, events: readonly unknown[]) => {
        appendCalls.push({ sagaStreamId, size: events.length });
      }
    };

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 2 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-1', amount: 100 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-2', amount: 200 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-2'
          }
        }
      ]
    };

    await persistSagaReducerOutputIntents('saga-stream-atomic', output, store);

    expect(appendCalls).toEqual([
      {
        sagaStreamId: 'saga-stream-atomic',
        size: 2
      }
    ]);
  });

  it('generates deterministic idempotency keys for equal intent content', () => {
    const firstIntent = {
      type: 'dispatch' as const,
      command: 'billing.charge' as const,
      payload: { amount: 250, invoiceId: 'inv-1' },
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    };

    const sameContentDifferentOrder = {
      type: 'dispatch' as const,
      command: 'billing.charge' as const,
      payload: { invoiceId: 'inv-1', amount: 250 },
      metadata: {
        causationId: 'cause-1',
        correlationId: 'corr-1',
        sagaId: 'saga-1'
      }
    };

    const firstKey = createSagaIntentIdempotencyKey('saga-stream-stable', 0, firstIntent);
    const secondKey = createSagaIntentIdempotencyKey('saga-stream-stable', 0, sameContentDifferentOrder);

    expect(firstKey).toBe(secondKey);
    expect(createSagaIntentIdempotencyKey('saga-stream-stable', 1, firstIntent)).not.toBe(firstKey);
    expect(createSagaIntentIdempotencyKey('saga-stream-other', 0, firstIntent)).not.toBe(firstKey);
  });
});
