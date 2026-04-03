import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  defineCustomAction,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  type CanonicalSagaIdentityInput,
  type SagaCustomActionBuilderCtx,
  type SagaPluginIntent
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
      interaction: 'fire_and_forget',
      build: (builderCtx: SagaCustomActionBuilderCtx<{ message: string }>, message: string) => {
        builderCtx.createPending({ execution_payload: { message } });
        return { message };
      }
    }),
    customFetch: defineCustomAction({
      interaction: 'request_response',
      build: (builderCtx: SagaCustomActionBuilderCtx<{ url: string }>, url: string) => {
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
      interaction: 'fire_and_forget',
      build: (message: string) => ({ message })
    },
    call: {
      interaction: 'request_response',
      build: (url: string) => ({ url })
    }
  }
});

describe('helper api typing and retry token phases', () => {
  it('infers defineOneWay/defineRequestResponse/defineCustomAction helper APIs', () => {
    const notifyKind: 'fire_and_forget' = HelperPlugin.actions.notify.interaction;
    const fetchKind: 'request_response' = HelperPlugin.actions.fetch.interaction;
    const customNotifyKind: 'fire_and_forget' = HelperPlugin.actions.customNotify.interaction;
    const customFetchKind: 'request_response' = HelperPlugin.actions.customFetch.interaction;

    const notifyPayload = HelperPlugin.actions.notify.build('audit', { invoiceId: 'inv-1' });
    const fetchPayload = HelperPlugin.actions.fetch.build('https://api.example.com/invoices/inv-1');
    const customNotifyPayload = HelperPlugin.actions.customNotify.build('hello');
    const customFetchPayload = HelperPlugin.actions.customFetch.build('https://api.example.com/invoices/inv-2');

    expect(notifyKind).toBe('fire_and_forget');
    expect(fetchKind).toBe('request_response');
    expect(customNotifyKind).toBe('fire_and_forget');
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
      .onResponses({
        ok: () => undefined,
        legacyOk: () => undefined
      })
      .onErrors({
        fail: () => undefined,
        legacyFail: () => undefined
      })
      .onRetries({
        retry: () => undefined
      })
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (state, event, ctx) => {
          const oneWay: SagaPluginIntent<'helpers', 'notify', { channel: 'audit' | 'ops'; body: { invoiceId: string } }, 'fire_and_forget'> =
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

          const oneWayOverride = ctx.actions.helpers
            .notify('ops', { invoiceId: event.payload.invoiceId })
            .retryPolicy({ maxAttempts: 2, initialBackoffMs: 50, backoffCoefficient: 2 })
            .onCompensation('helpers.notify.undo', { invoiceId: event.payload.invoiceId });
          const requestOverride = ctx.actions.helpers
            .fetch('https://api.example.com/with-overrides')
            .onResponse(ctx.onResponse.ok)
            .onError(ctx.onError.fail)
            .retryPolicy({ maxAttempts: 3, initialBackoffMs: 100, backoffCoefficient: 2 })
            .onCompensation('helpers.fetch.undo', { invoiceId: event.payload.invoiceId });

          const noDataHandler: undefined = noDataIntent.routing_metadata.handler_data;
          const withDataInvoiceId: string = withDataIntent.routing_metadata.handler_data.invoiceId;
          const withDataAttempt: number = withDataIntent.routing_metadata.handler_data.attempt;
          const retryKey: 'retry' = withRetryIntent.routing_metadata.retry_handler_key!;
          const oneWayMaxAttempts: number = oneWayOverride.retry_policy_override!.maxAttempts;
          const oneWayCompToken: string = oneWayOverride.compensation![0]!.token;
          const requestMaxAttempts: number = requestOverride.retry_policy_override!.maxAttempts;
          const requestCompToken: string = requestOverride.compensation![0]!.token;

          const legacyVoid = ctx.actions.legacy.log('legacy-ok');
          const legacyIntent = ctx.actions.legacy
            .call('https://legacy.example.com/inv-1')
            .onResponse(ctx.onResponse.legacyOk)
            .onError(ctx.onError.legacyFail);

          // @ts-expect-error request-response helper requires onResponse before onError
          ctx.actions.helpers.fetch('https://api.example.com/invalid').onError(ctx.onError.fail);

          const responseStep = ctx.actions.helpers.fetch('https://api.example.com/half').onResponse(ctx.onResponse.ok);

          // @ts-expect-error incomplete chain cannot be treated as terminal intent
          const incompleteIntent: SagaPluginIntent = responseStep;

          // @ts-expect-error request-response helper chain is required before terminal intent
          const directIntent: SagaPluginIntent = ctx.actions.helpers.fetch('https://api.example.com/direct');

          // @ts-expect-error onResponse accepts response-phase token only
          ctx.actions.helpers.fetch('https://api.example.com/mismatch').onResponse(ctx.onError.fail);

          // @ts-expect-error onRetry accepts retry-phase token only
          responseStep.onRetry(ctx.onError.fail);

          // @ts-expect-error onRetry token must match plugin/action binding
          responseStep.onRetry(ctx.onRetry.missing);

          // @ts-expect-error onError after onRetry still requires error-phase token
          responseStep.onRetry(ctx.onRetry.retry).onError(ctx.onRetry.retry);
          expect(oneWay.type).toBe('plugin-intent');
          expect(customOneWay.message).toBe('note');
          expect(noDataHandler).toBeUndefined();
          expect(withDataInvoiceId).toBe(event.payload.invoiceId);
          expect(withDataAttempt).toBe(1);
          expect(retryKey).toBe('retry');
          expect(oneWayMaxAttempts).toBe(2);
          expect(oneWayCompToken).toBe('helpers.notify.undo');
          expect(requestMaxAttempts).toBe(3);
          expect(requestCompToken).toBe('helpers.fetch.undo');
          expect(legacyVoid.message).toBe('legacy-ok');
          expect(legacyIntent.type).toBe('plugin-intent');

          state.retries += 1;
        }
      })
      .build();
  });
});
