import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas/internal/runtime';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
};

describe('createSaga ctx schedule/retry helper typing', () => {
  it('accepts valid schedule, cancelSchedule, and runActivity calls', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ attempted: 0 }))
      .on('invoice', {
        created: async ctx => {
          ctx.schedule('invoice-reminder', 5_000);
          ctx.cancelSchedule('invoice-reminder');

          await ctx.runActivity(
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

          return { state: ctx.state, intents: [] };
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('rejects invalid schedule and retry policy usage at compile time', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ attempted: 0 }))
      .on('invoice', {
        created: ctx => {
          // @ts-expect-error delay must be a number
          ctx.schedule('invoice-reminder', '5000');

          // @ts-expect-error id must be a string
          ctx.cancelSchedule(123);

          // @ts-expect-error closure must be a function
          ctx.runActivity('send-reminder', 'not-a-function');

          ctx.runActivity('send-reminder', () => undefined, {
            // @ts-expect-error retry policy must include numeric maxAttempts
            maxAttempts: '3',
            initialBackoffMs: 250,
            backoffCoefficient: 2
          });

          // @ts-expect-error retry policy requires backoffCoefficient
          ctx.runActivity('send-reminder', () => undefined, {
            maxAttempts: 3,
            initialBackoffMs: 250
          });

          return { state: ctx.state, intents: [] };
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
