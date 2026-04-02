import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  type SagaIntent,
  type SagaPluginRequestIntent,
  type SagaPluginRequestRoutingMetadata
} from '../src';

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

describe('S07 acceptance: intent metadata type shape', () => {
  it('ctx exposes saga metadata and all intent helpers return metadata fields', () => {
    createSaga<{ attempted: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: (state, _event, ctx) => {
          const ctxSagaId: string = ctx.metadata.sagaId;
          const ctxCorrelationId: string = ctx.metadata.correlationId;
          const ctxCausationId: string = ctx.metadata.causationId;

          const invoice = ctx.actions.core.dispatchTo(InvoiceAggregate, 'inv-1', { causationId: 'custom-cause' });

          const dispatchIntent = invoice['invoice.create'](
            'inv-1',
            100,
          );

          const scheduleIntent = ctx.actions.core.schedule('invoice-reminder', 5_000, {
            correlationId: 'custom-correlation'
          });

          const runActivityIntent = ctx.actions.core.runActivity(
            'send-reminder',
            () => Promise.resolve('ok'),
            {
              maxAttempts: 3,
              initialBackoffMs: 250,
              backoffCoefficient: 2
            }
          );
          state.attempted += 1;

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
    createSaga<{ attempted: number }>({ name: 'invoice-saga' })
      .initialState(() => ({ attempted: 0 }))
      .on(InvoiceAggregate, {
        created: (_state, _event, ctx) => {
          const invoice = ctx.commandsFor(InvoiceAggregate, 'inv-1', {
            // @ts-expect-error metadata values must be strings
            sagaId: 123
          });
          // @ts-expect-error metadata values must be strings
          ctx.actions.core.schedule('invoice-reminder', 5_000, { correlationId: 99 });

          // @ts-expect-error metadata values must be strings
          ctx.actions.core.runActivity('send-reminder', () => undefined, undefined, { causationId: false });

          // @ts-expect-error context metadata fields are required strings
          const invalid: number = ctx.metadata.sagaId;
          expect(invalid).toBeDefined();

        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('includes request-response plugin intent shape in SagaIntent union', () => {
    const routing: SagaPluginRequestRoutingMetadata<
      'http.get.success',
      'http.get.failure',
      { invoiceId: string }
    > = {
      response_handler_key: 'http.get.success',
      error_handler_key: 'http.get.failure',
      handler_data: { invoiceId: 'inv-2' }
    };

    const intent: SagaIntent = {
      type: 'plugin-request',
      plugin_key: 'http',
      action_name: 'get',
      action_kind: 'request_response',
      execution_payload: {
        url: 'https://api.example.com/invoices/inv-2'
      },
      routing_metadata: routing,
      metadata: {
        sagaId: 'saga-2',
        correlationId: 'corr-2',
        causationId: 'cause-2'
      }
    };

    const pluginIntent = intent as SagaPluginRequestIntent;
    expect(pluginIntent.routing_metadata.response_handler_key).toBe('http.get.success');

    // @ts-expect-error routing_metadata is required for plugin request intents
    const missingRouting: SagaPluginRequestIntent = {
      type: 'plugin-request',
      plugin_key: 'http',
      action_name: 'get',
      action_kind: 'request_response',
      execution_payload: {},
      metadata: {
        sagaId: 'saga-3',
        correlationId: 'corr-3',
        causationId: 'cause-3'
      }
    };

    expect(missingRouting).toBeDefined();
  });
});
