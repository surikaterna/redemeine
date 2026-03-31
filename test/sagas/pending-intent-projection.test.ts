import { describe, expect, it } from '@jest/globals';
import {
  PendingIntentProjection,
  type SagaLifecycleEvent,
  type SagaReducerOutput,
  createSagaIntentIdempotencyKey,
  createSagaIntentRecordedEvents
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

describe('S11 pending intent projection', () => {
  it('returns executable pending intents by due time', () => {
    const projection = new PendingIntentProjection<BillingCommandMap>();
    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-ready', amount: 100 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        {
          type: 'schedule',
          id: 'reminder-future',
          delay: 5_000,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-2'
          }
        }
      ]
    };

    const recordedEvents = createSagaIntentRecordedEvents(
      'saga-stream-1',
      output,
      () => '2026-03-30T00:00:00.000Z'
    );

    projection.projectEvents(recordedEvents, []);

    const executableNow = projection.getExecutablePendingIntents('2026-03-30T00:00:00.000Z');
    expect(executableNow).toHaveLength(1);
    expect(executableNow[0]).toMatchObject({
      intentKey: recordedEvents[0].idempotencyKey,
      status: 'pending',
      dueAt: '2026-03-30T00:00:00.000Z',
      intent: output.intents[0]
    });

    const executableLater = projection.getExecutablePendingIntents('2026-03-30T00:00:05.000Z');
    expect(executableLater).toHaveLength(2);
    expect(executableLater[1]).toMatchObject({
      intentKey: recordedEvents[1].idempotencyKey,
      status: 'pending',
      dueAt: '2026-03-30T00:00:05.000Z',
      intent: output.intents[1]
    });
  });

  it('excludes intents that reached completed lifecycle status', () => {
    const projection = new PendingIntentProjection<BillingCommandMap>();

    const output: SagaReducerOutput<{ attempts: number }, BillingCommandMap> = {
      state: { attempts: 1 },
      intents: [
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-success', amount: 100 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-1'
          }
        },
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-failed', amount: 200 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-2'
          }
        },
        {
          type: 'dispatch',
          command: 'billing.charge',
          payload: { invoiceId: 'inv-pending', amount: 300 },
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-3'
          }
        }
      ]
    };

    const recordedEvents = createSagaIntentRecordedEvents(
      'saga-stream-2',
      output,
      () => '2026-03-30T00:00:00.000Z'
    );

    const successIntentKey = createSagaIntentIdempotencyKey('saga-stream-2', 0, output.intents[0]);
    const failedIntentKey = createSagaIntentIdempotencyKey('saga-stream-2', 1, output.intents[1]);

    const lifecycleEvents: SagaLifecycleEvent[] = [
      {
        type: 'saga.intent-started',
        sagaStreamId: 'saga-stream-2',
        lifecycle: {
          intentKey: successIntentKey,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-start'
          }
        },
        startedAt: '2026-03-30T00:00:01.000Z'
      },
      {
        type: 'saga.intent-succeeded',
        sagaStreamId: 'saga-stream-2',
        lifecycle: {
          intentKey: successIntentKey,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-success'
          }
        },
        succeededAt: '2026-03-30T00:00:02.000Z'
      },
      {
        type: 'saga.intent-failed',
        sagaStreamId: 'saga-stream-2',
        lifecycle: {
          intentKey: failedIntentKey,
          metadata: {
            sagaId: 'saga-1',
            correlationId: 'corr-1',
            causationId: 'cause-failed'
          }
        },
        failedAt: '2026-03-30T00:00:03.000Z'
      }
    ];

    projection.projectEvents(recordedEvents, lifecycleEvents);

    const executable = projection.getExecutablePendingIntents('2026-03-30T00:00:10.000Z');
    expect(executable).toHaveLength(1);
    expect(executable[0].intent).toEqual(output.intents[2]);
    expect(executable[0].status).toBe('pending');

    const completed = projection.query({ statuses: ['succeeded', 'failed'] });
    expect(completed).toHaveLength(2);
    expect(completed.map(item => item.status).sort()).toEqual(['failed', 'succeeded']);
  });
});
