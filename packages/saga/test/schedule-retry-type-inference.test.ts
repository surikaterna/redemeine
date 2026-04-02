import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../src';

const InvoiceAggregate = {
  __aggregateType: 'invoice',
  pure: {
    eventProjectors: {
      created: (_state: unknown, _event: { payload: { invoiceId: string; amount: number } }) => undefined
    }
  },
  commandCreators: {
    'invoice.create': (invoiceId: string, amount: number) => ({
      type: 'invoice.create',
      payload: { invoiceId, amount }
    })
  }
} as const;

describe('createSaga ctx schedule/retry helper typing', () => {
  it('accepts valid schedule, cancelSchedule, and runActivity calls', () => {
    createSaga<{ attempted: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: async (state, _event, ctx) => {
          ctx.actions.core.schedule('invoice-reminder', 5_000);
          ctx.actions.core.cancelSchedule('invoice-reminder');

          await ctx.actions.core.runActivity(
            'send-reminder',
            () => Promise.resolve('ok'),
            {
              maxAttempts: 5,
              initialBackoffMs: 250,
              backoffCoefficient: 2,
              maxBackoffMs: 5_000,
              jitterCoefficient: 0.2
            }
          );
          state.attempted += 1;
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('rejects invalid schedule and retry policy usage at compile time', () => {
    createSaga<{ attempted: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          // @ts-expect-error delay must be a number
          ctx.actions.core.schedule('invoice-reminder', '5000');

          // @ts-expect-error id must be a string
          ctx.actions.core.cancelSchedule(123);

          // @ts-expect-error closure must be a function
          ctx.actions.core.runActivity('send-reminder', 'not-a-function');

          ctx.actions.core.runActivity('send-reminder', () => undefined, {
            // @ts-expect-error retry policy must include numeric maxAttempts
            maxAttempts: '3',
            initialBackoffMs: 250,
            backoffCoefficient: 2
          });

          // @ts-expect-error retry policy requires backoffCoefficient
          ctx.actions.core.runActivity('send-reminder', () => undefined, {
            maxAttempts: 3,
            initialBackoffMs: 250
          });
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
