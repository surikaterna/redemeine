import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
  'invoice.pay': { invoiceId: string; paidAt: string };
};

describe('createSaga ctx.dispatch type inference', () => {
  it('accepts valid command names and payloads', () => {
    const saga = createSaga<InvoiceCommandMap>()
      .initialState(() => ({ dispatched: 0 }))
      .on('invoice', {
        created: ctx => {
          ctx.dispatch('invoice.create', { invoiceId: 'inv-1', amount: 100 });
          ctx.dispatch('invoice.pay', { invoiceId: 'inv-1', paidAt: '2026-03-30T00:00:00.000Z' });
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
  });

  it('rejects invalid command keys and payload shapes at compile time', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ dispatched: 0 }))
      .on('invoice', {
        created: ctx => {
          // @ts-expect-error command key must exist in InvoiceCommandMap
          ctx.dispatch('invoice.cancel', { invoiceId: 'inv-1' });

          // @ts-expect-error payload for invoice.create must include amount:number
          ctx.dispatch('invoice.create', { invoiceId: 'inv-1' });
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
