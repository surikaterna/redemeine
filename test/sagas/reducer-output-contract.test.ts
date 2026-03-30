import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  type SagaIntent,
  type SagaReducerOutput
} from '../../src/sagas';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
  'billing.notify': { invoiceId: string; channel: 'email' | 'sms' };
};

describe('S08 reducer output contract typing', () => {
  it('accepts deterministic state transition output with typed intents', () => {
    const saga = createSaga<BillingCommandMap>()
      .initialState(() => ({ attempts: 0 as number, invoiceId: 'inv-1' as string }))
      .on('billing', {
        started: ctx => {
          const intents: readonly SagaIntent<BillingCommandMap>[] = [
            {
              type: 'dispatch',
              command: 'billing.charge',
              payload: { invoiceId: ctx.state.invoiceId, amount: 250 }
            },
            {
              type: 'dispatch',
              command: 'billing.notify',
              payload: { invoiceId: ctx.state.invoiceId, channel: 'email' }
            },
            { type: 'schedule', id: 'billing-reminder', delay: 5_000 },
            { type: 'cancelSchedule', id: 'billing-reminder' },
            { type: 'runActivity', name: 'send-receipt' }
          ];

          const output: SagaReducerOutput<typeof ctx.state, BillingCommandMap> = {
            state: {
              ...ctx.state,
              attempts: ctx.state.attempts + 1
            },
            intents
          };

          return output;
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
  });

  it('rejects invalid reducer output shapes at compile time', () => {
    createSaga<BillingCommandMap>()
      .initialState(() => ({ attempts: 0, invoiceId: 'inv-1' }))
      .on('billing', {
        started: ctx => {
          // @ts-expect-error reducer output requires intents array
          const missingIntents: SagaReducerOutput<typeof ctx.state, BillingCommandMap> = {
            state: ctx.state
          };

          // @ts-expect-error dispatch payload must match mapped command payload
          const badDispatchIntent: SagaIntent<BillingCommandMap> = {
            type: 'dispatch',
            command: 'billing.charge',
            payload: { invoiceId: 'inv-1', amount: '250' }
          };

          // @ts-expect-error schedule delay must be number
          const badScheduleIntent: SagaIntent<BillingCommandMap> = {
            type: 'schedule',
            id: 'billing-reminder',
            delay: '5000'
          };

          return {
            state: missingIntents.state,
            intents: [badDispatchIntent, badScheduleIntent]
          };
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
