import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  defineCustomAction,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  type CanonicalSagaIdentityInput,
  type SagaPluginOneWayIntent,
  type SagaPluginRequestIntent
} from '../src';

const HELPER_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'helper_type_inference',
  version: 1
};

const InvoiceAggregate = {
  __aggregateType: 'invoice',
  pure: {
    eventProjectors: {
      created: (_state: unknown, _event: { payload: { invoiceId: string } }) => undefined
    }
  },
  commandCreators: {}
} as const;

const HelperPlugin = defineSagaPlugin({
  plugin_key: 'helpers',
  actions: {
    notify: defineOneWay((channel: 'audit' | 'ops', body: { invoiceId: string }) => ({ channel, body })),
    fetch: defineRequestResponse((url: string, headers?: Record<string, string>) => ({ url, headers })),
    customNotify: defineCustomAction({
      action_kind: 'void',
      build: (builderCtx, message: string) => {
        builderCtx.createPending({ execution_payload: { message } });
        return { message };
      }
    }),
    customFetch: defineCustomAction({
      action_kind: 'request_response',
      build: (builderCtx, url: string) => {
        builderCtx.createPending({ execution_payload: { url } });
        return { url };
      }
    })
  }
});

const LegacyPlugin = defineSagaPlugin({
  plugin_key: 'legacy',
  actions: {
    log: {
      action_kind: 'void',
      build: (message: string) => ({ message })
    },
    call: {
      action_kind: 'request_response',
      build: (url: string) => ({ url })
    }
  }
});

describe('helper api typing and retry token phases', () => {
  it('infers defineOneWay/defineRequestResponse/defineCustomAction helper APIs', () => {
    const notifyKind: 'void' = HelperPlugin.actions.notify.action_kind;
    const fetchKind: 'request_response' = HelperPlugin.actions.fetch.action_kind;
    const customNotifyKind: 'void' = HelperPlugin.actions.customNotify.action_kind;
    const customFetchKind: 'request_response' = HelperPlugin.actions.customFetch.action_kind;

    const notifyPayload = HelperPlugin.actions.notify.build('audit', { invoiceId: 'inv-1' });
    const fetchPayload = HelperPlugin.actions.fetch.build('https://api.example.com/invoices/inv-1');
    const customNotifyPayload = HelperPlugin.actions.customNotify.build('hello');
    const customFetchPayload = HelperPlugin.actions.customFetch.build('https://api.example.com/invoices/inv-2');

    expect(notifyKind).toBe('void');
    expect(fetchKind).toBe('request_response');
    expect(customNotifyKind).toBe('void');
    expect(customFetchKind).toBe('request_response');
    expect(notifyPayload.channel).toBe('audit');
    expect(fetchPayload.url).toContain('/invoices/');
    expect(customNotifyPayload.message).toBe('hello');
    expect(customFetchPayload.url).toContain('/invoices/');
  });

  it('enforces request-response terminal chain with optional withData and onRetry', () => {
    createSaga({
      identity: HELPER_IDENTITY,
      plugins: [HelperPlugin, LegacyPlugin] as const
    })
      .responseDefinitions({
        ok: {
          plugin_key: 'helpers',
          action_name: 'fetch',
          phase: 'response'
        },
        fail: {
          plugin_key: 'helpers',
          action_name: 'fetch',
          phase: 'error'
        },
        retry: {
          plugin_key: 'helpers',
          action_name: 'fetch',
          phase: 'retry'
        },
        legacyOk: {
          plugin_key: 'legacy',
          action_name: 'call',
          phase: 'response'
        },
        legacyFail: {
          plugin_key: 'legacy',
          action_name: 'call',
          phase: 'error'
        }
      })
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (state, event, ctx) => {
          const oneWay: SagaPluginOneWayIntent<'helpers', 'notify', { channel: 'audit' | 'ops'; body: { invoiceId: string } }> =
            ctx.actions.helpers.notify('audit', { invoiceId: event.payload.invoiceId });
          const customOneWay = ctx.actions.helpers.customNotify('note');

          const noDataIntent = ctx.actions.helpers
            .fetch('https://api.example.com/no-data')
            .onResponse(ctx.onResponse.ok)
            .onError(ctx.onError.fail);
          const withDataIntent = ctx.actions.helpers
            .fetch('https://api.example.com/with-data')
            .withData({ invoiceId: event.payload.invoiceId, attempt: 1 })
            .onResponse(ctx.onResponse.ok)
            .onError(ctx.onError.fail);
          const withRetryIntent = ctx.actions.helpers
            .fetch('https://api.example.com/with-retry')
            .onResponse(ctx.onResponse.ok)
            .onRetry(ctx.onRetry.retry)
            .onError(ctx.onError.fail);

          const noDataHandler: undefined = noDataIntent.routing_metadata.handler_data;
          const withDataInvoiceId: string = withDataIntent.routing_metadata.handler_data.invoiceId;
          const withDataAttempt: number = withDataIntent.routing_metadata.handler_data.attempt;
          const retryKey: 'retry' = withRetryIntent.routing_metadata.retry_handler_key!;

          const legacyVoid = ctx.actions.legacy.log('legacy-ok');
          const legacyIntent = ctx.actions.legacy
            .call('https://legacy.example.com/inv-1')
            .onResponse(ctx.onResponse.legacyOk)
            .onError(ctx.onError.legacyFail);

          // @ts-expect-error request-response helper requires onResponse before onError
          ctx.actions.helpers.fetch('https://api.example.com/invalid').onError(ctx.onError.fail);

          const responseStep = ctx.actions.helpers.fetch('https://api.example.com/half').onResponse(ctx.onResponse.ok);

          // @ts-expect-error incomplete chain cannot be treated as terminal intent
          const incompleteIntent: SagaPluginRequestIntent = responseStep;

          // @ts-expect-error request-response helper chain is required before terminal intent
          const directIntent: SagaPluginRequestIntent = ctx.actions.helpers.fetch('https://api.example.com/direct');

          // @ts-expect-error onResponse accepts response-phase token only
          ctx.actions.helpers.fetch('https://api.example.com/mismatch').onResponse(ctx.onError.fail);

          // @ts-expect-error onRetry accepts retry-phase token only
          responseStep.onRetry(ctx.onError.fail);

          // @ts-expect-error onRetry token must match plugin/action binding
          responseStep.onRetry(ctx.onRetry.missing);

          // @ts-expect-error onError after onRetry still requires error-phase token
          responseStep.onRetry(ctx.onRetry.retry).onError(ctx.onRetry.retry);

          createSaga({
            identity: {
              namespace: 'plugins',
              name: 'invalid_retry_phase',
              version: 1
            },
            plugins: [HelperPlugin] as const
          })
            .responseDefinitions({
              // @ts-expect-error phase must be response|error|retry
              invalid: { plugin_key: 'helpers', action_name: 'fetch', phase: 'retrying' }
            })
            .build();

          expect(oneWay.type).toBe('plugin-one-way');
          expect(customOneWay.message).toBe('note');
          expect(noDataHandler).toBeUndefined();
          expect(withDataInvoiceId).toBe(event.payload.invoiceId);
          expect(withDataAttempt).toBe(1);
          expect(retryKey).toBe('retry');
          expect(legacyVoid.message).toBe('legacy-ok');
          expect(legacyIntent.type).toBe('plugin-request');

          state.retries += 1;
        }
      })
      .build();
  });
});
