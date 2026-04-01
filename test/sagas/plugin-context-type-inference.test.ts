import { describe, expect, it } from '@jest/globals';
import { createSaga, defineSagaPlugin } from '../../src/sagas';

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
  it('infers plugin manifest literals with action-kind distinctions', () => {
    const httpPlugin = defineSagaPlugin({
      plugin_key: 'http',
      version: '1.0.0',
      description: 'HTTP integration',
      actions: {
        ping: {
          action_kind: 'void',
          build: (url: string) => ({ url })
        },
        get: {
          action_kind: 'request_response',
          build: (url: string, headers?: Record<string, string>) => ({ url, headers })
        }
      }
    });

    const pluginKey: 'http' = httpPlugin.plugin_key;
    const pingKind: 'void' = httpPlugin.actions.ping.action_kind;
    const getKind: 'request_response' = httpPlugin.actions.get.action_kind;
    const pingPayload = httpPlugin.actions.ping.build('https://example.com/ping');
    const getPayload = httpPlugin.actions.get.build('https://example.com/items', { authorization: 'Bearer x' });

    expect(pluginKey).toBe('http');
    expect(pingKind).toBe('void');
    expect(getKind).toBe('request_response');
    expect(pingPayload.url).toBe('https://example.com/ping');
    expect(getPayload.url).toBe('https://example.com/items');

    defineSagaPlugin({
      plugin_key: 'broken',
      actions: {
        execute: {
          // @ts-expect-error action_kind must be one of the supported literals
          action_kind: 'request',
          build: () => ({})
        }
      }
    });
  });

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
