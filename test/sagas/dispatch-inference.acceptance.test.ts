import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas';

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
    }),
    'invoice.pay': (invoiceId: string, paidAt: string) => ({
      type: 'invoice.pay',
      payload: { invoiceId, paidAt }
    })
  }
} as const;

describe('S27 acceptance: aggregate-driven dispatch inference safety', () => {
  it('valid command creator calls compile for known aggregate command keys', () => {
    const saga = createSaga<{ dispatched: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ dispatched: 0 }))
      .on(InvoiceAggregate, {
        created: (state, _event, ctx) => {
          const invoice = ctx.actions.core.dispatchTo(InvoiceAggregate, 'inv-1');
          invoice['invoice.create']('inv-1', 100);
          invoice['invoice.pay']('inv-1', '2026-03-30T00:00:00.000Z');
          state.dispatched += 1;
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
  });

  it('invalid payload fails at compile time', () => {
    createSaga<{ dispatched: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ dispatched: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          const invoice = ctx.actions.core.dispatch(InvoiceAggregate, 'inv-1');
          // @ts-expect-error invoice.create signature requires (invoiceId: string, amount: number)
          invoice['invoice.create']({ invoiceId: 'inv-1' });
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('invalid command key fails at compile time', () => {
    createSaga<{ dispatched: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ dispatched: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          const invoice = ctx.commandsFor(InvoiceAggregate, 'inv-1');
          type CommandKey = keyof typeof invoice;
          // @ts-expect-error command key must exist in command creators
          const invalid: CommandKey = 'invoice.cancel';
          expect(invalid).toBeDefined();
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
