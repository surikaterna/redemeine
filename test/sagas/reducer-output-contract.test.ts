import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  type SagaIntent,
  type SagaReducerOutput
} from '../../src/sagas';

const BillingAggregate = {
  __aggregateType: 'billing',
  pure: {
    eventProjectors: {
      started: (_state: unknown, _event: { payload: { invoiceId: string } }) => undefined
    }
  },
  commandCreators: {
    'billing.charge': (invoiceId: string, amount: number) => ({
      type: 'billing.charge',
      payload: { invoiceId, amount }
    }),
    'billing.notify': (invoiceId: string, channel: 'email' | 'sms') => ({
      type: 'billing.notify',
      payload: { invoiceId, channel }
    })
  }
} as const;

describe('S08 reducer output contract typing', () => {
  it('accepts deterministic state transition output with typed intents', () => {
    const saga = createSaga<{ attempts: number; invoiceId: string }>({ name: 'billing-saga' })
      .initialState(() => ({ attempts: 0 as number, invoiceId: 'inv-1' as string }))
      .on(BillingAggregate, {
        started: (state, _event, ctx) => {
          const intents: readonly SagaIntent[] = [
            {
              type: 'dispatch',
              command: 'billing.charge',
              payload: { invoiceId: state.invoiceId, amount: 250 },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-1'
              }
            },
            {
              type: 'dispatch',
              command: 'billing.notify',
              payload: { invoiceId: state.invoiceId, channel: 'email' },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-2'
              }
            },
            {
              type: 'schedule',
              id: 'billing-reminder',
              delay: 5_000,
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-3'
              }
            },
            {
              type: 'cancel-schedule',
              id: 'billing-reminder',
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-4'
              }
            },
            {
              type: 'run-activity',
              name: 'send-receipt',
              closure: () => undefined,
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-5'
              }
            }
          ];

          const output: SagaReducerOutput<typeof state> = {
            state: {
              ...state,
              attempts: state.attempts + 1
            },
            intents
          };

          state.attempts = output.state.attempts;
          output.intents.forEach(ctx.emit);
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
    expect(saga.plugins).toEqual([]);
    expect(saga.response_handlers).toEqual({});
  });

  it('rejects invalid reducer output shapes at compile time', () => {
    createSaga<{ attempts: number; invoiceId: string }>({ name: 'billing-saga' })
      .initialState(() => ({ attempts: 0, invoiceId: 'inv-1' }))
      .on(BillingAggregate, {
        started: (state, _event, _ctx) => {
          // @ts-expect-error reducer output requires intents array
          const missingIntents: SagaReducerOutput<typeof state> = {
            state
          };

          const badDispatchIntent: SagaIntent = {
            type: 'dispatch',
            command: 'billing.charge',
            payload: { invoiceId: 'inv-1', amount: '250' },
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-1'
            }
          };

          const badScheduleIntent: SagaIntent = {
            type: 'schedule',
            id: 'billing-reminder',
            // @ts-expect-error schedule delay must be number
            delay: '5000',
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-2'
            }
          };

          expect(missingIntents).toBeDefined();
          expect(badDispatchIntent).toBeDefined();
          expect(badScheduleIntent).toBeDefined();
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
