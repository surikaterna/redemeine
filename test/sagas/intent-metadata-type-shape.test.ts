import { describe, expect, it } from '@jest/globals';
import { createSaga } from '../../src/sagas';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
};

describe('S07 acceptance: intent metadata type shape', () => {
  it('ctx exposes saga metadata and all intent helpers return metadata fields', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ attempted: 0 }))
      .on('invoice', {
        created: ctx => {
          const ctxSagaId: string = ctx.metadata.sagaId;
          const ctxCorrelationId: string = ctx.metadata.correlationId;
          const ctxCausationId: string = ctx.metadata.causationId;

          const dispatchIntent = ctx.dispatch(
            'invoice.create',
            { invoiceId: 'inv-1', amount: 100 },
            { causationId: 'custom-cause' }
          );

          const scheduleIntent = ctx.schedule('invoice-reminder', 5_000, {
            correlationId: 'custom-correlation'
          });

          const runActivityIntent = ctx.runActivity(
            'send-reminder',
            () => Promise.resolve('ok'),
            {
              maxAttempts: 3,
              initialBackoffMs: 250,
              backoffCoefficient: 2
            },
            {
              sagaId: 'explicit-saga-id'
            }
          );

          const dispatchedSagaId: string = dispatchIntent.metadata.sagaId;
          const scheduledCorrelationId: string = scheduleIntent.metadata.correlationId;
          const activityCausationId: string = runActivityIntent.metadata.causationId;

          expect(ctxSagaId).toBeDefined();
          expect(ctxCorrelationId).toBeDefined();
          expect(ctxCausationId).toBeDefined();
          expect(dispatchedSagaId).toBeDefined();
          expect(scheduledCorrelationId).toBeDefined();
          expect(activityCausationId).toBeDefined();
        }
      })
      .build();
  });

  it('rejects invalid metadata shapes at compile time', () => {
    createSaga<InvoiceCommandMap>()
      .initialState(() => ({ attempted: 0 }))
      .on('invoice', {
        created: ctx => {
          // @ts-expect-error metadata values must be strings
          ctx.dispatch('invoice.create', { invoiceId: 'inv-1', amount: 100 }, { sagaId: 123 });

          // @ts-expect-error metadata values must be strings
          ctx.schedule('invoice-reminder', 5_000, { correlationId: 99 });

          // @ts-expect-error metadata values must be strings
          ctx.runActivity('send-reminder', () => undefined, undefined, { causationId: false });

          // @ts-expect-error context metadata fields are required strings
          const invalid: number = ctx.metadata.sagaId;
          expect(invalid).toBeDefined();
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
