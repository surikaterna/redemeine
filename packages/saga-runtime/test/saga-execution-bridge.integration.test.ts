import { describe, expect, it } from '@jest/globals';
import {
  createSagaExecutionBridge,
  createReferenceAdaptersV1,
  type SagaAggregateState
} from '../src';
import type { CanonicalInspectionEnvelope } from '@redemeine/kernel';

declare const require: (id: string) => any;

const sagaPackage = require('@redemeine/saga');

const {
  createSaga,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin
} = sagaPackage as {
  createSaga: <TState = unknown>(options: Record<string, unknown>) => any;
  defineOneWay: <TBuild extends (...args: any[]) => unknown>(build: TBuild) => unknown;
  defineRequestResponse: <TBuild extends (...args: any[]) => unknown>(build: TBuild) => unknown;
  defineSagaPlugin: (manifest: Record<string, unknown>) => unknown;
};

const OrderAggregate = {
  __aggregateType: 'orders',
  pure: {
    eventProjectors: {
      started: (
        _state: unknown,
        _event: {
          payload: { orderId: string; amount: number; customerId: string };
        }
      ) => undefined
    }
  },
  commandCreators: {}
} as const;

const PaymentsPlugin = defineSagaPlugin({
  plugin_key: 'payments',
  actions: {
    authorize: defineRequestResponse((payload: { orderId: string; amount: number }) => payload)
  }
});

const TelemetryPlugin = defineSagaPlugin({
  plugin_key: 'telemetry',
  actions: {
    record: defineOneWay((payload: { name: string; customerId: string }) => payload)
  }
});

const createBridgeSaga = () => createSaga({
  identity: {
    namespace: 'runtime',
    name: 'bridge_contract',
    version: 1
  },
  plugins: [PaymentsPlugin, TelemetryPlugin] as const
})
  .initialState(() => ({ attempts: 0, lastOrderId: '' }))
  .onResponses({
    'payments.authorize.ok': () => undefined
  })
  .onErrors({
    'payments.authorize.failed': () => undefined
  })
  .on(OrderAggregate, {
    started: (state: { attempts: number; lastOrderId: string }, event: { payload: { orderId: string; amount: number; customerId: string } }, ctx: any) => {
      ctx.actions.payments
        .authorize({ orderId: event.payload.orderId, amount: event.payload.amount })
        .onResponse(ctx.onResponse['payments.authorize.ok'])
        .onError(ctx.onError['payments.authorize.failed']);

      ctx.actions.telemetry.record({
        name: 'order.started',
        customerId: event.payload.customerId
      });

      state.attempts += 1;
      state.lastOrderId = event.payload.orderId;
    }
  })
  .build();

describe('saga execution bridge integration', () => {
  it('bridges SagaAggregate orchestration with SagaInstance handlers and plugin contracts', async () => {
    const definition = createBridgeSaga();
    const adapters = createReferenceAdaptersV1();
    const bridge = createSagaExecutionBridge({
      definition,
      adapters,
      runtimePlugins: [PaymentsPlugin, TelemetryPlugin] as const
    });

    const result = await bridge.dispatch({
      sagaId: 'saga-bridge-1',
      event: {
        type: 'orders.started.event',
        payload: {
          orderId: 'order-1',
          amount: 1900,
          customerId: 'customer-7'
        },
        aggregateType: 'orders',
        aggregateId: 'order-1',
        eventId: 'evt-1',
        occurredAt: '2026-01-01T00:00:00.000Z'
      },
      nowIso: '2026-01-01T00:00:01.000Z'
    });

    expect(result.handled).toBe(true);
    expect(result.matchedHandlers).toEqual(['started']);
    expect(result.sagaState).toEqual({ attempts: 1, lastOrderId: 'order-1' });
    expect(result.intents.map((intent) => intent.type)).toEqual(['plugin-intent', 'plugin-intent']);

    expect(result.adapterResults).toHaveLength(1);
    expect(result.adapterResults[0]).toMatchObject({
      processedIntents: 2,
      persistedExecutions: ['saga-bridge-1:intent:1', 'saga-bridge-1:intent:2']
    });

    expect(adapters.sideEffects.listHandled()).toHaveLength(2);
    expect(adapters.sideEffects.listHandled()[0]).toMatchObject({
      type: 'plugin-intent',
      plugin_key: 'payments',
      action_name: 'authorize',
      interaction: 'request_response',
      routing_metadata: {
        response_handler_key: 'payments.authorize.ok',
        error_handler_key: 'payments.authorize.failed'
      }
    });
    expect(adapters.sideEffects.listHandled()[1]).toMatchObject({
      type: 'plugin-intent',
      plugin_key: 'telemetry',
      action_name: 'record',
      interaction: 'fire_and_forget'
    });

    const aggregateState = bridge.getAggregateState('saga-bridge-1') as SagaAggregateState;
    expect(aggregateState.id).toBe('saga-bridge-1');
    expect(aggregateState.totals.observedEvents).toBe(1);
    expect(aggregateState.totals.intents).toBe(2);
    expect(aggregateState.recent.intents.map((entry) => entry.intentType).sort()).toEqual([
      'plugin-intent',
      'plugin-intent'
    ]);
  });

  it('returns deterministic no-op result when no saga handler matches', async () => {
    const definition = createBridgeSaga();
    const bridge = createSagaExecutionBridge({
      definition,
      runtimePlugins: [PaymentsPlugin, TelemetryPlugin] as const
    });

    const result = await bridge.dispatch({
      sagaId: 'saga-bridge-unmatched',
      event: {
        type: 'inventory.adjusted.event',
        payload: { id: 'inv-1' },
        aggregateType: 'inventory'
      }
    });

    expect(result.handled).toBe(false);
    expect(result.matchedHandlers).toEqual([]);
    expect(result.intents).toEqual([]);
    expect(result.adapterResults).toEqual([]);
    expect(result.sagaState).toBeUndefined();
    expect(result.aggregateState.id).toBeNull();
  });

  it('keeps execution ids monotonic across repeated dispatches and traceable to aggregate lifecycle ids', async () => {
    const definition = createBridgeSaga();
    const adapters = createReferenceAdaptersV1();
    const bridge = createSagaExecutionBridge({
      definition,
      adapters,
      runtimePlugins: [PaymentsPlugin, TelemetryPlugin] as const
    });

    const first = await bridge.dispatch({
      sagaId: 'saga-bridge-repeat',
      event: {
        type: 'orders.started.event',
        payload: { orderId: 'order-a', amount: 100, customerId: 'customer-1' },
        aggregateType: 'orders',
        aggregateId: 'order-a',
        eventId: 'evt-a'
      }
    });

    const second = await bridge.dispatch({
      sagaId: 'saga-bridge-repeat',
      event: {
        type: 'orders.started.event',
        payload: { orderId: 'order-b', amount: 200, customerId: 'customer-2' },
        aggregateType: 'orders',
        aggregateId: 'order-b',
        eventId: 'evt-b'
      }
    });

    expect(first.adapterResults[0]?.persistedExecutions).toEqual([
      'saga-bridge-repeat:intent:1',
      'saga-bridge-repeat:intent:2'
    ]);
    expect(second.adapterResults[0]?.persistedExecutions).toEqual([
      'saga-bridge-repeat:intent:3',
      'saga-bridge-repeat:intent:4'
    ]);

    const persisted = adapters.persistence.listIntentExecutionsBySagaId('saga-bridge-repeat');
    const persistedIds = persisted
      .map((entry) => entry.id)
      .sort((a, b) => a.localeCompare(b));

    expect(persistedIds).toEqual([
      'saga-bridge-repeat:intent:1',
      'saga-bridge-repeat:intent:2',
      'saga-bridge-repeat:intent:3',
      'saga-bridge-repeat:intent:4'
    ]);

    const aggregateState = bridge.getAggregateState('saga-bridge-repeat');
    const lifecycleIds = aggregateState.recent.intents
      .map((entry) => entry.intentId)
      .sort((a, b) => a.localeCompare(b));

    expect(lifecycleIds).toEqual(persistedIds);
    expect(aggregateState.totals.intents).toBe(4);
  });

  it('emits canonical saga-runtime inspection hooks with legacy telemetry compatibility mapping', async () => {
    const definition = createBridgeSaga();
    const adapters = createReferenceAdaptersV1();
    const inspectionEvents: CanonicalInspectionEnvelope[] = [];

    const bridge = createSagaExecutionBridge({
      definition,
      adapters,
      runtimePlugins: [PaymentsPlugin, TelemetryPlugin] as const,
      inspection: (event) => {
        inspectionEvents.push(event);
      }
    });

    await bridge.dispatch({
      sagaId: 'saga-inspect-1',
      event: {
        type: 'orders.started.event',
        payload: {
          orderId: 'order-1',
          amount: 100,
          customerId: 'customer-1'
        },
        aggregateType: 'orders',
        aggregateId: 'order-1',
        eventId: 'evt-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    });

    const sourceObserved = inspectionEvents.find((event) => event.hook === 'source_event.observed');
    const sideEffectExecution = inspectionEvents.find((event) => event.hook === 'side_effect.execution');

    expect(sourceObserved).toMatchObject({
      schema: 'redemeine.inspection/v1',
      runtime: 'saga-runtime',
      compatibility: {
        legacyHook: 'runtime.telemetry'
      },
      ids: {
        sagaId: 'saga-inspect-1',
        eventType: 'orders.started.event',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    });

    expect(sideEffectExecution).toMatchObject({
      schema: 'redemeine.inspection/v1',
      runtime: 'saga-runtime',
      compatibility: {
        legacyHook: 'runtime.telemetry'
      },
      ids: {
        sagaId: 'saga-inspect-1'
      }
    });
  });
});
