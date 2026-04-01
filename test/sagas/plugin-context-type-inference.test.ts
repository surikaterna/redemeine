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
    })
  }
} as const;

type SagaPluginHelpers = {
  scheduleCommand: (name: 'invoice.retry', delayMs: number) => { jobId: string };
  https: {
    get: (url: string, headers?: Record<string, string>) => Promise<{ status: number }>;
  };
};

describe('createSaga plugin-capable ctx typing', () => {
  it('infers plugin helper extensions alongside base ctx methods', () => {
    createSaga<{ retries: number }, SagaPluginHelpers>('plugin-saga')
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: async (state, event, ctx) => {
          const scheduled = ctx.scheduleCommand('invoice.retry', 5000);
          const response = await ctx.https.get(`https://api.example.com/invoices/${event.payload.invoiceId}`);

          const jobId: string = scheduled.jobId;
          const statusCode: number = response.status;

          ctx.schedule('invoice-reminder', 1_000);
          ctx.cancelSchedule('invoice-reminder');
          ctx.runActivity('audit', () => ({ invoiceId: event.payload.invoiceId }));

          expect(jobId).toBeDefined();
          expect(statusCode).toBeGreaterThanOrEqual(100);
          state.retries += 1;
        }
      })
      .build();
  });

  it('rejects invalid plugin helper usage at compile time', () => {
    createSaga<{ retries: number }, SagaPluginHelpers>()
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          // @ts-expect-error scheduleCommand requires number delay
          ctx.scheduleCommand('invoice.retry', '5000');

          // @ts-expect-error unknown plugin helper name
          ctx.http.get('https://api.example.com/health');

          // @ts-expect-error base ctx still enforces schedule signature
          ctx.schedule(123, 1000);
        }
      })
      .build();

    expect(true).toBe(true);
  });
});
