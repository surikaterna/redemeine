import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  deriveSagaUrn,
  type CanonicalSagaIdentityInput,
  type SagaIntent,
  type SagaReducerOutput
} from '../src';

const BILLING_SAGA_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'billing',
  name: 'billing_saga',
  version: 1
};

const BillingAggregate = {
  aggregateType: 'billing',
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

describe('S08 reducer output contract typing', () => {
  it('accepts deterministic state transition output with typed intents', () => {
    const saga = createSaga<{ attempts: number; invoiceId: string }>({ identity: BILLING_SAGA_IDENTITY })
      .initialState(() => ({ attempts: 0 as number, invoiceId: 'inv-1' as string }))
      .on(BillingAggregate, {
        started: (state, _event, ctx) => {
          const intents: readonly SagaIntent[] = [
            {
              type: 'plugin-intent',
              plugin_key: 'core',
              action_name: 'dispatch',
              interaction: 'fire_and_forget',
              execution_payload: {
                command: 'billing.charge',
                payload: { invoiceId: state.invoiceId, amount: 250 },
                aggregateId: 'billing-1'
              },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-1'
              }
            },
            {
              type: 'plugin-intent',
              plugin_key: 'core',
              action_name: 'dispatch',
              interaction: 'fire_and_forget',
              execution_payload: {
                command: 'billing.notify',
                payload: { invoiceId: state.invoiceId, channel: 'email' },
                aggregateId: 'billing-1'
              },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-2'
              }
            },
            {
              type: 'plugin-intent',
              plugin_key: 'core',
              action_name: 'schedule',
              interaction: 'fire_and_forget',
              execution_payload: {
                id: 'billing-reminder',
                delay: 5_000
              },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-3'
              }
            },
            {
              type: 'plugin-intent',
              plugin_key: 'core',
              action_name: 'cancelSchedule',
              interaction: 'fire_and_forget',
              execution_payload: {
                id: 'billing-reminder'
              },
              metadata: {
                sagaId: 'saga-1',
                correlationId: 'corr-1',
                causationId: 'cause-4'
              }
            }

          ];

          const output: SagaReducerOutput<typeof state> = {
            state: {
              ...state,
              attempts: state.attempts + 1
            },
            intents
          };

          state.attempts = output.state.attempts;
          output.intents.forEach(ctx.emit);
        }
      })
      .build();

    expect(saga.handlers).toHaveLength(1);
    expect(saga.plugins).toEqual([]);
    expect(saga.responseHandlers).toEqual({});
    expect(saga.errorHandlers).toEqual({});
    expect(saga.retryHandlers).toEqual({});
    expect(saga.identity).toEqual({
      namespace: 'billing',
      name: 'billing_saga',
      version: 1,
      sagaKey: 'billing/billing_saga',
      sagaType: 'billing/billing_saga@v1',
      sagaUrn: 'urn:redemeine:saga:billing:billing_saga:v1'
    });
    expect(saga.sagaKey).toBe('billing/billing_saga');
    expect(saga.sagaType).toBe('billing/billing_saga@v1');
    expect(saga.sagaUrn).toBe('urn:redemeine:saga:billing:billing_saga:v1');
    expect(deriveSagaUrn({
      namespace: saga.identity.namespace,
      name: saga.identity.name,
      version: saga.identity.version
    })).toBe(saga.sagaUrn);
    expect(saga.correlations).toEqual([]);
    expect(saga.handlers[0]?.sagaType).toBe('billing/billing_saga@v1');
    expect(saga.handlers[0]?.sagaUrn).toBe('urn:redemeine:saga:billing:billing_saga:v1');
  });

  it('rejects invalid reducer output shapes at compile time', () => {
    createSaga<{ attempts: number; invoiceId: string }>({ identity: BILLING_SAGA_IDENTITY })
      .initialState(() => ({ attempts: 0, invoiceId: 'inv-1' }))
      .on(BillingAggregate, {
        started: (state, _event, _ctx) => {
          // @ts-expect-error reducer output requires intents array
          const missingIntents: SagaReducerOutput<typeof state> = {
            state
          };

          const badDispatchIntent: SagaIntent = {
            type: 'plugin-intent',
            plugin_key: 'core',
            action_name: 'dispatch',
            interaction: 'fire_and_forget',
            execution_payload: {
              command: 'billing.charge',
              payload: { invoiceId: 'inv-1', amount: '250' },
              aggregateId: 'billing-1'
            },
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-1'
            }
          };

          const badScheduleIntent: SagaIntent = {
            type: 'plugin-intent',
            plugin_key: 'core',
            action_name: 'schedule',
            interaction: 'fire_and_forget',
            execution_payload: {
              id: 'billing-reminder',
              delay: '5000'
            },
            metadata: {
              sagaId: 'saga-1',
              correlationId: 'corr-1',
              causationId: 'cause-2'
            }
          };

          expect(missingIntents).toBeDefined();
          expect(badDispatchIntent).toBeDefined();
          expect(badScheduleIntent).toBeDefined();
        }
      })
      .build();

    expect(true).toBe(true);
  });

  it('keeps runtime handler maps in camelCase public API', () => {
    const responseFn = (_state: { attempts: number }, _response: { token: 'billing.charge.ok' }) => undefined;
    const errorFn = (_state: { attempts: number }, _error: { token: 'billing.charge.failed' }) => undefined;

    const saga = createSaga<{ attempts: number }>({
      identity: {
        namespace: 'billing',
        name: 'billing_saga_runtime_maps',
        version: 1
      }
    })
      .onResponses({
        'billing.charge.ok': responseFn
      })
      .onErrors({
        'billing.charge.failed': errorFn
      })
      .build();

    expect(saga.responseHandlers).toEqual({
      'billing.charge.ok': responseFn
    });
    expect(saga.errorHandlers).toEqual({
      'billing.charge.failed': errorFn
    });
    expect(saga.retryHandlers).toEqual({});
    expect(typeof saga.responseHandlers['billing.charge.ok']).toBe('function');
  });
});
