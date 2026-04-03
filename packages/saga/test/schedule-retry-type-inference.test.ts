import { describe, expect, it } from '@jest/globals';
import { createSaga, type CanonicalSagaIdentityInput } from '../src';

const INVOICE_SAGA_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'billing',
  name: 'invoice_saga',
  version: 1
};

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

describe('createSaga ctx schedule helper typing', () => {
  it('accepts valid schedule and cancelSchedule calls', () => {
    createSaga<{ attempted: number }>({ identity: INVOICE_SAGA_IDENTITY })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: async (state, _event, ctx) => {
          ctx.actions.core.schedule('invoice-reminder', 5_000);
          ctx.actions.core.cancelSchedule('invoice-reminder');

          state.attempted += 1;
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('rejects invalid schedule and retry policy usage at compile time', () => {
    createSaga<{ attempted: number }>({ identity: INVOICE_SAGA_IDENTITY })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          // @ts-expect-error delay must be a number
          ctx.actions.core.schedule('invoice-reminder', '5000');

          // @ts-expect-error id must be a string
          ctx.actions.core.cancelSchedule(123);

        }
      })
      .build();

    expect(true).toBe(true);
  });
});
