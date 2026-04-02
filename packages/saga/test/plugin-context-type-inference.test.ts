import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  defineSagaPlugin,
  type CanonicalSagaIdentityInput,
  type SagaPluginRequestIntent
} from '../src';

const PLUGIN_SAGA_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'plugin_saga',
  version: 1
};

const PLUGIN_RESPONSE_BROKEN_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'plugin_saga_response_broken',
  version: 1
};

const PLUGIN_WITH_DATA_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'plugin_saga_with_data',
  version: 1
};

const PLUGIN_OPTIONAL_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'plugin_optional_saga',
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

const InfraPlugin = defineSagaPlugin({
  plugin_key: 'infra',
  actions: {
    scheduleCommand: {
      action_kind: 'void',
      build: (name: 'invoice.retry', delayMs: number) => ({ name, delayMs })
    }
  }
});

const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    get: {
      action_kind: 'request_response',
      build: (url: string, headers?: Record<string, string>) => ({ url, headers })
    },
    post: {
      action_kind: 'request_response',
      build: (url: string, body: unknown) => ({ url, body })
    }
  }
});

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
    const saga = createSaga({
      identity: PLUGIN_SAGA_IDENTITY,
      plugins: [InfraPlugin, HttpPlugin] as const
    })
      .responseDefinitions({
        'http.get.success': {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'response'
        },
        'http.get.failure': {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'error'
        },
        'http.post.success': {
          plugin_key: 'http',
          action_name: 'post',
          phase: 'response'
        },
        'http.post.failure': {
          plugin_key: 'http',
          action_name: 'post',
          phase: 'error'
        }
      })
      .initialState(() => ({ retries: 0 }))
      .onResponses({
        'http.get.success': (state, response, ctx) => {
          const token: 'http.get.success' = response.token;
          const pluginKey: string = response.request.plugin_key;

          ctx.actions.core.schedule('response-followup', 500);
          state.retries += 1;

          expect(token).toBe('http.get.success');
          expect(pluginKey).toBe('http');
        }
      })
      .onErrors({
        'http.get.failure': (state, error, ctx) => {
          const token: 'http.get.failure' = error.token;
          const actionName: string = error.request.action_name;

          ctx.actions.core.cancelSchedule('response-followup');
          state.retries += 1;

          expect(token).toBe('http.get.failure');
          expect(actionName).toBe('get');
        }
      })
      .on(InvoiceAggregate, {
        created: async (state, event, ctx) => {
          const scheduled = ctx.actions.infra.scheduleCommand('invoice.retry', 5000);
          const requestIntent = ctx.actions.http
            .get(`https://api.example.com/invoices/${event.payload.invoiceId}`)
            .withData({ invoiceId: event.payload.invoiceId })
            .onResponse(ctx.onResponse['http.get.success'])
            .onError(ctx.onError['http.get.failure']);
          const successToken: 'http.get.success' = ctx.onResponse['http.get.success'];
          const errorToken: 'http.get.failure' = ctx.onError['http.get.failure'];

          const jobName: 'invoice.retry' = scheduled.name;
          const routedInvoiceId: string = requestIntent.routing_metadata.handler_data.invoiceId;
          const statusHeaders: Record<string, string> | undefined = requestIntent.execution_payload.headers;

          ctx.actions.core.schedule('invoice-reminder', 1_000);
          ctx.actions.core.cancelSchedule('invoice-reminder');
          ctx.actions.core.runActivity('audit', () => ({ invoiceId: event.payload.invoiceId }));

          expect(jobName).toBe('invoice.retry');
          expect(routedInvoiceId).toBe(event.payload.invoiceId);
          expect(statusHeaders).toBeDefined();
          expect(successToken).toBe('http.get.success');
          expect(errorToken).toBe('http.get.failure');
          state.retries += 1;
        }
      })
      .build();

    expect(saga.response_handlers['http.get.success'].plugin_key).toBe('http');
    expect(saga.response_handlers['http.get.success'].action_name).toBe('get');
    expect(saga.response_handlers['http.get.success'].phase).toBe('response');
    expect(typeof saga.executable_response_handlers?.['http.get.success']).toBe('function');
    expect(typeof saga.executable_error_handlers?.['http.get.failure']).toBe('function');
    expect(saga.plugins).toEqual([
      {
        plugin_key: 'infra',
        plugin_kind: 'manifest',
        action_names: ['scheduleCommand']
      },
      {
        plugin_key: 'http',
        plugin_kind: 'manifest',
        action_names: ['get', 'post']
      }
    ]);

    const pluginKind: 'manifest' = saga.plugins[1].plugin_kind;
    expect(pluginKind).toBe('manifest');
  });

  it('rejects invalid plugin helper usage at compile time', () => {
    createSaga({
      identity: PLUGIN_SAGA_IDENTITY,
      plugins: [InfraPlugin, HttpPlugin] as const
    })
      .responseDefinitions({
        okay: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'response'
        },
        fail: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'error'
        },
        postOkay: {
          plugin_key: 'http',
          action_name: 'post',
          phase: 'response'
        },
        postFail: {
          plugin_key: 'http',
          action_name: 'post',
          phase: 'error'
        }
      })
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          // @ts-expect-error scheduleCommand requires number delay
          ctx.actions.infra.scheduleCommand('invoice.retry', '5000');

          // @ts-expect-error unknown plugin helper name
          ctx.actions.web.get('https://api.example.com/health');

          // @ts-expect-error request-response actions require routing chain via withData
          const directRequestPayload: { url: string; headers?: Record<string, string> } = ctx.actions.http.get('https://api.example.com/health');

          // @ts-expect-error void actions do not expose request-response chain methods
          ctx.actions.infra.scheduleCommand('invoice.retry', 5000).onResponse;

          const builtRequest = ctx.actions.http.get('https://api.example.com/health').withData({ ok: true });

          // @ts-expect-error request-response chain requires onResponse before onError
          builtRequest.onError(ctx.onError.fail);

          // @ts-expect-error onResponse only accepts response-phase token for plugin/action
          builtRequest.onResponse(ctx.onError.okay);

          const responseSelected = builtRequest.onResponse(ctx.onResponse.okay);

          // @ts-expect-error request-response chain requires onError before yielding an intent
          const partialIntent: { routing_metadata: unknown } = responseSelected;

          // @ts-expect-error onError only accepts error-phase token for plugin/action
          responseSelected.onError(ctx.onResponse.okay);

          // @ts-expect-error onResponse token must match originating plugin/action
          builtRequest.onResponse(ctx.onResponse.postOkay);

          // @ts-expect-error onError token must match originating plugin/action
          responseSelected.onError(ctx.onError.postFail);

          const chainedIntent = ctx.actions.http
            .post('https://api.example.com/jobs', { id: 'job-1' })
            .withData({ jobId: 'job-1' })
            .onResponse(ctx.onResponse.postOkay)
            .onError(ctx.onError.postFail);

          // @ts-expect-error response token keys are phase-specific
          ctx.onResponse.missing;

          // @ts-expect-error error token keys are phase-specific
          ctx.onError.okay;

          // @ts-expect-error core action manifest enforces schedule signature
          ctx.actions.core.schedule(123, 1000);

          const chainedJobId: string = chainedIntent.routing_metadata.handler_data.jobId;

          expect(responseSelected).toBeDefined();
          expect(directRequestPayload).toBeDefined();
          expect(chainedJobId).toBe('job-1');
        }
      })
      .build();

    createSaga({
      identity: PLUGIN_RESPONSE_BROKEN_IDENTITY,
      plugins: [InfraPlugin, HttpPlugin] as const
    })
      .responseDefinitions({
        broken: {
          plugin_key: 'http',
          action_name: 'get',
          // @ts-expect-error phase must be response|error
          phase: 'success'
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('enforces phase-safe executable response/error handler registration', () => {
    createSaga({
      name: 'plugin-saga-executable-handler-gating',
      plugins: [InfraPlugin, HttpPlugin] as const
    })
      .responseDefinitions({
        okay: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'response'
        },
        fail: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'error'
        }
      })
      // @ts-expect-error onResponses only accepts response-phase tokens
      .onResponses({
        okay: (_state, _response, _ctx) => undefined,
        fail: (_state, _response, _ctx) => undefined
      })
      // @ts-expect-error onErrors only accepts error-phase tokens
      .onErrors({
        fail: (_state, _error, _ctx) => undefined,
        okay: (_state, _error, _ctx) => undefined
      })
      .build();

    createSaga({
      name: 'plugin-saga-no-defs'
    })
      // @ts-expect-error no responseDefinitions means no executable response keys
      .onResponses({
        anything: (_state, _response, _ctx) => undefined
      })
      // @ts-expect-error no responseDefinitions means no executable error keys
      .onErrors({
        anything: (_state, _error, _ctx) => undefined
      })
      .build();

    expect(true).toBe(true);
  });

  it('types request-response plugin intent with separated payload and routing metadata', () => {
    const intent: SagaPluginRequestIntent<
      'http',
      'get',
      { url: string; headers?: Record<string, string> },
      {
        response_handler_key: 'http.get.success';
        error_handler_key: 'http.get.failure';
        handler_data: { invoiceId: string };
      }
    > = {
      type: 'plugin-request',
      plugin_key: 'http',
      action_name: 'get',
      action_kind: 'request_response',
      execution_payload: {
        url: 'https://api.example.com/invoices/inv-1',
        headers: { authorization: 'Bearer t' }
      },
      routing_metadata: {
        response_handler_key: 'http.get.success',
        error_handler_key: 'http.get.failure',
        handler_data: { invoiceId: 'inv-1' }
      },
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    };

    const url: string = intent.execution_payload.url;
    const handlerInvoiceId: string = intent.routing_metadata.handler_data.invoiceId;

    // @ts-expect-error routing metadata is distinct from execution payload
    intent.execution_payload.response_handler_key;

    // @ts-expect-error execution payload fields are not in routing metadata
    intent.routing_metadata.url;

    expect(url).toContain('https://api.example.com');
    expect(handlerInvoiceId).toBe('inv-1');
  });

  it('propagates withData typing into routing metadata handler_data', () => {
    createSaga({
      identity: PLUGIN_WITH_DATA_IDENTITY,
      plugins: [InfraPlugin, HttpPlugin] as const
    })
      .responseDefinitions({
        success: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'response'
        },
        failure: {
          plugin_key: 'http',
          action_name: 'get',
          phase: 'error'
        }
      })
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          const intent = ctx.actions.http
            .get('https://api.example.com/invoices/inv-3')
            .withData({ invoiceId: 'inv-3', attempt: 1 })
            .onResponse(ctx.onResponse.success)
            .onError(ctx.onError.failure);

          const invoiceId: string = intent.routing_metadata.handler_data.invoiceId;
          const attempt: number = intent.routing_metadata.handler_data.attempt;

          // @ts-expect-error handler_data must preserve withData property types
          const wrongAttempt: string = intent.routing_metadata.handler_data.attempt;

          expect(invoiceId).toBe('inv-3');
          expect(attempt).toBe(1);
          expect(wrongAttempt).toBeDefined();
        }
      })
      .build();
  });

  it('keeps optional plugin configuration valid when omitted', () => {
    const saga = createSaga({
      identity: PLUGIN_OPTIONAL_IDENTITY
    })
      .initialState(() => ({ retries: 0 }))
      .on(InvoiceAggregate, {
        created: (state, _event, ctx) => {
          ctx.actions.core.schedule('invoice-reminder', 500);
          ctx.actions.core.cancelSchedule('invoice-reminder');

          // @ts-expect-error plugin helpers are unavailable when plugins are omitted
          ctx.actions.http.get('https://api.example.com/invoices/inv-4');

          state.retries += 1;
        }
      })
      .build();

    expect(saga.plugins).toEqual([]);
  });
});
