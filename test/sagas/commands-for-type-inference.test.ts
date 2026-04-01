import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas';

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

describe('R5 acceptance: ctx.commandsFor aggregate wrapper typing', () => {
  it('infers command methods and payload shape from aggregate command creators', () => {
    createSaga<{ attempts: number }>('billing-saga')
      .initialState(() => ({ attempts: 0 }))
      .on(BillingAggregate, {
        started: (state, event, ctx) => {
          const commands = ctx.commandsFor(BillingAggregate, 'billing-agg-1');

          const chargeIntent = commands['billing.charge']('inv-1', 250);
          const notifyIntent = commands['billing.notify']('inv-1', 'email');

          const commandName: 'billing.charge' = chargeIntent.command;
          const payloadAmount: number = chargeIntent.payload.amount;
          const aggregateId: string = chargeIntent.aggregateId;
          const metadataSagaId: string = chargeIntent.metadata.sagaId;
          const notifyChannel: 'email' | 'sms' = notifyIntent.payload.channel;
          const eventInvoiceId: string = event.payload.invoiceId;
          state.attempts += 1;

          expect(commandName).toBe('billing.charge');
          expect(payloadAmount).toBe(250);
          expect(aggregateId).toBe('billing-agg-1');
          expect(metadataSagaId).toBeDefined();
          expect(notifyChannel).toBe('email');
          expect(eventInvoiceId).toBeDefined();
        }
      })
      .build();
  });

  it('rejects unknown command names and invalid payload signatures at compile time', () => {
    createSaga<{ attempts: number }>({ name: 'billing-saga' })
      .initialState(() => ({ attempts: 0 }))
      .on(BillingAggregate, {
        started: (_state, _event, ctx) => {
          const commands = ctx.commandsFor(BillingAggregate, 'billing-agg-1', {
            causationId: 'custom-cause'
          });

          type CommandKeys = keyof typeof commands;
          // @ts-expect-error command method must exist on aggregate command creators
          const invalidCommandKey: CommandKeys = 'billing.cancel';
          expect(invalidCommandKey).toBeDefined();

          // @ts-expect-error billing.charge signature is (invoiceId: string, amount: number)
          commands['billing.charge']({ invoiceId: 'inv-1', amount: 250 });

          // @ts-expect-error billing.notify channel must be 'email' | 'sms'
          commands['billing.notify']('inv-1', 'push');
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
