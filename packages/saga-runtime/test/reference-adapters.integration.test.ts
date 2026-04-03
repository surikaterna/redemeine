import { describe, expect, it } from '@jest/globals';
import {
  createReferenceAdaptersV1,
  createInMemoryPersistencePluginV1,
  createInMemorySchedulerPluginV1,
  createInMemorySideEffectsPluginV1,
  createInMemoryTelemetryPluginV1,
  runReferenceAdapterFlowV1,
  type SagaIntent
} from '../src/referenceAdapters';

const metadata = {
  sagaId: 'saga-777',
  correlationId: 'corr-777',
  causationId: 'cause-777'
} as const;

describe('reference adapters v1 integration', () => {
  it('provides in-memory persistence adapters with projection interfaces', () => {
    const persistence = createInMemoryPersistencePluginV1();

    persistence.sagaProjection.upsert({
      id: 'saga-777',
      sagaType: 'order_workflow',
      lifecycleState: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      transitionVersion: 1,
      totals: {
        transitions: 0,
        observedEvents: 0,
        intents: 0,
        activities: 0
      },
      recent: {
        transitions: [],
        events: [],
        intents: [],
        activities: []
      }
    });

    persistence.intentExecutionProjection.upsert({
      id: 'exec-1',
      sagaId: 'saga-777',
      intentId: 'plugin-request:1',
      status: 'in_progress',
      attempt: 1,
      retryPolicySnapshot: null,
      responseRef: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    expect(persistence.sagaProjection.getById('saga-777')?.lifecycleState).toBe('active');
    expect(persistence.listIntentExecutionsBySagaId('saga-777')).toHaveLength(1);
  });

  it('schedules and drains due triggers with scheduler policy', () => {
    const scheduler = createInMemorySchedulerPluginV1();

    scheduler.schedule({
      id: 'trigger-a',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:01.000Z',
      policy: {
        restart: { mode: 'graceful', reason: 'overlap' },
        misfire: { mode: 'catch_up_bounded', maxCatchUpCount: 2 }
      }
    });

    scheduler.schedule({
      id: 'trigger-b',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:03.000Z'
    });

    expect(scheduler.listScheduled().map((entry) => entry.id)).toEqual(['trigger-a', 'trigger-b']);
    expect(scheduler.drainDue('2026-01-01T00:00:02.000Z').map((entry) => entry.id)).toEqual(['trigger-a']);
    expect(scheduler.listScheduled().map((entry) => entry.id)).toEqual(['trigger-b']);
  });

  it('executes side effects and captures handled intents', async () => {
    const sideEffects = createInMemorySideEffectsPluginV1();

    const pluginOneWay = await sideEffects.execute({
      type: 'plugin-one-way',
      plugin_key: 'payments',
      action_name: 'notify',
      action_kind: 'void',
      execution_payload: { orderId: 'order-1' },
      metadata
    });

    const pluginRequest = await sideEffects.execute({
      type: 'plugin-request',
      plugin_key: 'payments',
      action_name: 'authorize',
      action_kind: 'request_response',
      execution_payload: { amount: 123 },
      routing_metadata: {
        response_handler_key: 'payments.authorize.ok',
        error_handler_key: 'payments.authorize.failed',
        handler_data: { orderId: 'order-1' }
      },
      metadata
    });

    const activity = await sideEffects.execute({
      type: 'run-activity',
      name: 'reserve-stock',
      closure: () => ({ reserved: true }),
      metadata
    });

    expect(pluginOneWay.status).toBe('succeeded');
    expect(pluginRequest.responseRef?.responseKey).toBe('payments.authorize');
    expect(activity.output).toEqual({ reserved: true });
    expect(sideEffects.listHandled()).toHaveLength(3);
  });

  it('records telemetry counters and events', () => {
    const telemetry = createInMemoryTelemetryPluginV1();

    telemetry.count('saga.intent.received');
    telemetry.count('saga.intent.received', 2);
    telemetry.event('saga.intent.executed', { status: 'succeeded' });

    const snapshot = telemetry.snapshot();
    expect(snapshot.counters['saga.intent.received']).toBe(3);
    expect(snapshot.events[0]?.name).toBe('saga.intent.executed');
  });

  it('runs reference flow end-to-end across persistence scheduler side-effects telemetry', async () => {
    const adapters = createReferenceAdaptersV1();
    const intents: SagaIntent[] = [
      {
        type: 'schedule',
        id: 'wake-up',
        delay: 500,
        metadata
      },
      {
        type: 'plugin-request',
        plugin_key: 'billing',
        action_name: 'charge',
        action_kind: 'request_response',
        execution_payload: { amount: 1900 },
        routing_metadata: {
          response_handler_key: 'billing.charge.ok',
          error_handler_key: 'billing.charge.failed',
          handler_data: { paymentId: 'pay-1' }
        },
        metadata
      },
      {
        type: 'plugin-one-way',
        plugin_key: 'email',
        action_name: 'sendReceipt',
        action_kind: 'void',
        execution_payload: { orderId: 'order-777' },
        metadata
      },
      {
        type: 'run-activity',
        name: 'enrich-order',
        closure: () => ({ enriched: true }),
        metadata
      },
      {
        type: 'cancel-schedule',
        id: 'wake-up',
        metadata
      }
    ];

    const result = await runReferenceAdapterFlowV1(adapters, {
      sagaId: 'saga-777',
      intents,
      nowIso: '2026-01-01T00:00:00.000Z',
      schedulerPolicy: {
        restart: { mode: 'force', reason: 'overlap' },
        misfire: { mode: 'latest_only' }
      }
    });

    expect(result.processedIntents).toBe(5);
    expect(result.scheduledTriggerIds).toEqual(['wake-up']);
    expect(result.persistedExecutions).toHaveLength(3);

    const persisted = adapters.persistence.listIntentExecutionsBySagaId('saga-777');
    expect(persisted).toHaveLength(3);
    expect(persisted.every((entry) => entry.status === 'succeeded')).toBe(true);

    expect(adapters.scheduler.listScheduled()).toHaveLength(0);

    const telemetry = adapters.telemetry.snapshot();
    expect(telemetry.counters['saga.intent.received']).toBe(5);
    expect(telemetry.counters['saga.intent.executed']).toBe(3);
    expect(telemetry.counters['saga.intent.scheduled']).toBe(1);
    expect(telemetry.counters['saga.intent.cancelled_schedule']).toBe(1);
  });
});
