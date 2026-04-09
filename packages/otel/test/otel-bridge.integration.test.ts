import { describe, expect, it } from '@jest/globals';
import {
  createInMemoryPersistencePluginV1,
  createInMemorySchedulerPluginV1,
  createInMemorySideEffectsPluginV1,
  createReferenceAdaptersV1,
  runReferenceAdapterFlowV1,
  type SagaIntent,
  type SagaRuntimeTelemetryEvent
} from '../../saga-runtime/src';
import { createOtelTelemetryBridge } from '../src';

const metadata = {
  sagaId: 'saga-otel-1',
  correlationId: 'corr-otel-1',
  causationId: 'cause-otel-1'
} as const;

describe('@redemeine/otel bridge integration', () => {
  it('wires otel bridge into runtime adapters and preserves trace continuity tags', async () => {
    const spans: SagaRuntimeTelemetryEvent[] = [];
    const telemetry = createOtelTelemetryBridge({
      emitSpan: (event) => {
        spans.push(event);
      }
    });

    const adapters = createReferenceAdaptersV1({
      persistence: createInMemoryPersistencePluginV1(),
      scheduler: createInMemorySchedulerPluginV1(),
      sideEffects: createInMemorySideEffectsPluginV1(),
      telemetry
    });

    const intents: SagaIntent[] = [
      {
        type: 'plugin-intent',
        plugin_key: 'payments',
        action_name: 'authorize',
        interaction: 'request_response',
        execution_payload: { amount: 4900 },
        routing_metadata: {
          response_handler_key: 'payments.authorize.ok',
          error_handler_key: 'payments.authorize.failed',
          handler_data: { orderId: 'order-otel-1' }
        },
        metadata
      },
      {
        type: 'run-activity',
        name: 'order.audit.prepare',
        closure: () => ({ ok: true }),
        metadata: {
          ...metadata,
          correlationId: 'corr-otel-2',
          causationId: 'cause-otel-2'
        }
      }
    ];

    const result = await runReferenceAdapterFlowV1(adapters, {
      sagaId: metadata.sagaId,
      nowIso: '2026-01-01T00:00:00.000Z',
      intents
    });

    expect(telemetry.instrumentation).toBe('@redemeine/otel');
    expect(result.persistedExecutions).toHaveLength(2);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.name).toBe('saga.intent.executed');
    expect(spans[0]?.tags).toMatchObject({
      sagaId: 'saga-otel-1',
      status: 'succeeded',
      correlationId: 'corr-otel-1',
      causationId: 'cause-otel-1'
    });
    expect(spans[1]?.tags).toMatchObject({
      sagaId: 'saga-otel-1',
      status: 'succeeded',
      correlationId: 'corr-otel-2',
      causationId: 'cause-otel-2'
    });
  });
});
