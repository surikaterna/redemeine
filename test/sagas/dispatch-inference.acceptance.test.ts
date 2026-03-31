import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas/internal/runtime';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
  'invoice.pay': { invoiceId: string; paidAt: string };
};

describe('S27 acceptance: ctx.dispatch inference safety', () => {
  it('valid payload compiles for known command key', () => {
    const saga = createSaga<InvoiceCommandMap>()
      .initialState(() => ({ dispatched: 0 }))
      .on('invoice', {
        created: ctx => {
          ctx.dispatch('invoice.create', { invoiceId: 'inv-1', amount: 100 });
          ctx.dispatch('invoice.pay', { invoiceId: 'inv-1', paidAt: '2026-03-30T00:00:00.000Z' });

          return { state: ctx.state, intents: [] };
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
  });

  it('invalid payload fails at compile time', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ dispatched: 0 }))
      .on('invoice', {
        created: ctx => {
          // @ts-expect-error payload for invoice.create must include amount:number
          ctx.dispatch('invoice.create', { invoiceId: 'inv-1' });

          return { state: ctx.state, intents: [] };
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('invalid command key fails at compile time', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ dispatched: 0 }))
      .on('invoice', {
        created: ctx => {
          // @ts-expect-error command key must exist in InvoiceCommandMap
          ctx.dispatch('invoice.cancel', { invoiceId: 'inv-1' });

          return { state: ctx.state, intents: [] };
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
