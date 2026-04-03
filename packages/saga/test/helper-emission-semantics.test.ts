import { describe, expect, it } from '@jest/globals';
import {
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  runSagaHandler,
  type SagaAggregateEventByName,
  type SagaPluginIntent
} from '../src';

const NotifyPlugin = defineSagaPlugin({
  plugin_key: 'notify',
  actions: {
    publish: defineOneWay((channel: string, body: { invoiceId: string }) => ({ channel, body }))
  }
});

const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    fetch: defineRequestResponse((url: string) => ({ url }))
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

const InvoiceAggregate = {
  __aggregateType: 'invoice',
  pure: {
    eventProjectors: {
      created: (_state: unknown, _event: { payload: { invoiceId: string } }) => undefined
    }
  },
  commandCreators: {}
} as const;

const httpBindings = {
  'http.fetch.ok': {
    plugin_key: 'http',
    action_name: 'fetch',
    phase: 'response'
  },
  'http.fetch.fail': {
    plugin_key: 'http',
    action_name: 'fetch',
    phase: 'error'
  },
  'http.fetch.retry': {
    plugin_key: 'http',
    action_name: 'fetch',
    phase: 'retry'
  }
} as const;

const legacyBindings = {
  'legacy.call.ok': {
    plugin_key: 'legacy',
    action_name: 'call',
    phase: 'response'
  },
  'legacy.call.fail': {
    plugin_key: 'legacy',
    action_name: 'call',
    phase: 'error'
  }
} as const;

describe('helper action runtime emission semantics', () => {
  it('emits one-way helper intents immediately and emits request-response once at terminal step', async () => {
    const output = await runSagaHandler(
      { attempts: 0 },
      { type: 'invoice.created.event', payload: { invoiceId: 'inv-1' } } as SagaAggregateEventByName<typeof InvoiceAggregate, 'created'>,
      async (state, event, ctx) => {
        const oneWayIntent: SagaPluginIntent<'notify', 'publish', { channel: string; body: { invoiceId: string } }, 'fire_and_forget'> = ctx.actions.notify.publish(
          'audit',
          { invoiceId: event.payload.invoiceId }
        )
          .retryPolicy({
            maxAttempts: 2,
            initialBackoffMs: 100,
            backoffCoefficient: 2
          })
          .onCompensation('notify.undo', { invoiceId: event.payload.invoiceId, step: 1 })
          .onCompensation('notify.audit', { invoiceId: event.payload.invoiceId, step: 2 });

        const noDataStep = ctx.actions.http
          .fetch('https://api.example.com/invoices/inv-1')
          .onResponse(ctx.onResponse['http.fetch.ok']);

        const noDataIntent = noDataStep.onError(ctx.onError['http.fetch.fail']);
        const duplicateNoDataIntent = noDataStep.onError(ctx.onError['http.fetch.fail']);

        const retryIntent = ctx.actions.http
          .fetch('https://api.example.com/invoices/inv-1/retry')
          .onResponse(ctx.onResponse['http.fetch.ok'])
          .onRetry(ctx.onRetry['http.fetch.retry'])
          .onError(ctx.onError['http.fetch.fail'])
          .retryPolicy({
            maxAttempts: 4,
            initialBackoffMs: 250,
            backoffCoefficient: 2
          })
          .onCompensation('http.fetch.undo', { invoiceId: event.payload.invoiceId, step: 1 })
          .onCompensation('http.fetch.audit', { invoiceId: event.payload.invoiceId, step: 2 });

        const withDataIntent = ctx.actions.http
          .fetch('https://api.example.com/invoices/inv-1/data')
          .withData({ invoiceId: event.payload.invoiceId, attempt: 1 })
          .onResponse(ctx.onResponse['http.fetch.ok'])
          .onError(ctx.onError['http.fetch.fail']);

        expect(oneWayIntent.type).toBe('plugin-intent');
        expect(oneWayIntent.retry_policy_override).toEqual({
          maxAttempts: 2,
          initialBackoffMs: 100,
          backoffCoefficient: 2
        });
        expect(oneWayIntent.compensation).toEqual([
          { token: 'notify.undo', payload: { invoiceId: 'inv-1', step: 1 } },
          { token: 'notify.audit', payload: { invoiceId: 'inv-1', step: 2 } }
        ]);
        expect(noDataIntent.routing_metadata.handler_data).toBeUndefined();
        expect(duplicateNoDataIntent).toBe(noDataIntent);
        expect(retryIntent.routing_metadata.retry_handler_key).toBe('http.fetch.retry');
        expect(retryIntent.retry_policy_override).toEqual({
          maxAttempts: 4,
          initialBackoffMs: 250,
          backoffCoefficient: 2
        });
        expect(retryIntent.compensation).toEqual([
          { token: 'http.fetch.undo', payload: { invoiceId: 'inv-1', step: 1 } },
          { token: 'http.fetch.audit', payload: { invoiceId: 'inv-1', step: 2 } }
        ]);
        expect(withDataIntent.routing_metadata.handler_data).toEqual({ invoiceId: 'inv-1', attempt: 1 });

        state.attempts += 1;
      },
      {
        sagaId: 'saga-helpers',
        correlationId: 'corr-helpers',
        causationId: 'cause-helpers'
      },
      httpBindings,
      [NotifyPlugin, HttpPlugin] as const
    );

    expect(output.state).toEqual({ attempts: 1 });
    expect(output.intents).toHaveLength(4);
    expect(output.intents[0]).toMatchObject({
      type: 'plugin-intent',
      plugin_key: 'notify',
      action_name: 'publish',
      interaction: 'fire_and_forget'
    });
    expect(output.intents.filter((intent) => intent.type === 'plugin-intent' && intent.interaction === 'request_response')).toHaveLength(3);
  });

  it('preserves backward-compatible behavior for legacy raw descriptors', async () => {
    const output = await runSagaHandler(
      { attempts: 0 },
      { type: 'invoice.created.event', payload: { invoiceId: 'inv-2' } } as SagaAggregateEventByName<typeof InvoiceAggregate, 'created'>,
      async (state, _event, ctx) => {
        const legacyResult = ctx.actions.legacy.log('legacy-log');
        const legacyRequest = ctx.actions.legacy
          .call('https://legacy.example.com/inv-2')
          .withData({ source: 'legacy' })
          .onResponse(ctx.onResponse['legacy.call.ok'])
          .onError(ctx.onError['legacy.call.fail']);

        expect(legacyResult).toEqual({ message: 'legacy-log' });
        expect(legacyRequest.routing_metadata.handler_data).toEqual({ source: 'legacy' });

        state.attempts += 1;
      },
      {
        sagaId: 'saga-legacy',
        correlationId: 'corr-legacy',
        causationId: 'cause-legacy'
      },
      legacyBindings,
      [LegacyPlugin] as const
    );

    expect(output.state).toEqual({ attempts: 1 });
    expect(output.intents).toHaveLength(1);
    expect(output.intents[0]).toMatchObject({
      type: 'plugin-intent',
      plugin_key: 'legacy',
      action_name: 'call',
      interaction: 'request_response'
    });
  });
});
