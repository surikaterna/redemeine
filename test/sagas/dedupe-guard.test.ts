import { describe, expect, it } from '@jest/globals';
import type { SagaReducerOutput } from '../../src/sagas';
import {
  InMemorySagaRuntimeEventBuffer,
  PendingIntentProjection,
  appendSagaIntentDispatchedEvent,
  appendSagaIntentSucceededEvent,
  createSagaIntentRecordedEvents,
  decideIntentExecutionFromRecordedLifecycleEvents,
  decideIntentExecutionFromProjection
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('saga execution dedupe guard', () => {
  it('returns no-op when intent key has already succeeded', async () => {
    const store = new InMemorySagaRuntimeEventBuffer();

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-1', amount: 150 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        }
      ]
    };

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-1', output, () => '2026-03-30T00:00:00.000Z');
    await store.appendIntentRecordedBatch('saga-stream-1', [recorded]);
    await appendSagaIntentSucceededEvent(
      store,
      {
        sagaStreamId: 'saga-stream-1',
        intentKey: recorded.idempotencyKey,
        metadata: recorded.intent.metadata
      },
      () => '2026-03-30T00:00:01.000Z'
    );

    const decision = await decideIntentExecutionFromRecordedLifecycleEvents(
      store,
      'saga-stream-1',
      recorded.idempotencyKey
    );

    expect(decision).toEqual({
      shouldExecute: false,
      reason: 'no-op-already-succeeded'
    });
  });

  it('returns no-op when intent key has already been dispatched', async () => {
    const store = new InMemorySagaRuntimeEventBuffer();

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-2', amount: 300 },
          metadata: {
            sagaId: 'saga-2',
            correlationId: 'corr-2',
            causationId: 'cause-2'
          }
        }
      ]
    };

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-2', output, () => '2026-03-30T00:00:00.000Z');
    await store.appendIntentRecordedBatch('saga-stream-2', [recorded]);
    await appendSagaIntentDispatchedEvent(
      store,
      {
        sagaStreamId: 'saga-stream-2',
        intentKey: recorded.idempotencyKey,
        metadata: recorded.intent.metadata
      },
      () => '2026-03-30T00:00:00.500Z'
    );

    const decision = await decideIntentExecutionFromRecordedLifecycleEvents(
      store,
      'saga-stream-2',
      recorded.idempotencyKey
    );

    expect(decision).toEqual({
      shouldExecute: false,
      reason: 'no-op-already-dispatched'
    });
  });

  it('returns execute for pending intent keys', () => {
    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-3', amount: 400 },
          metadata: {
            sagaId: 'saga-3',
            correlationId: 'corr-3',
            causationId: 'cause-3'
          }
        }
      ]
    };

    const [recorded] = createSagaIntentRecordedEvents('saga-stream-3', output, () => '2026-03-30T00:00:00.000Z');
    const projection = new PendingIntentProjection<BillingCommandMap>();
    projection.projectEvents([recorded], []);

    const decision = decideIntentExecutionFromProjection(projection, recorded.idempotencyKey);

    expect(decision).toEqual({
      shouldExecute: true,
      reason: 'execute'
    });
  });
});
