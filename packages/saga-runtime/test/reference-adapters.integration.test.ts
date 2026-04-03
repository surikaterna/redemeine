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
    expect(scheduler.listPolicyOutcomes()).toEqual([
      expect.objectContaining({
        triggerId: 'trigger-a',
        outcome: expect.objectContaining({
          misfireMode: 'catch_up_bounded',
          wasMisfire: true,
          dueCount: 1,
          executedCount: 1,
          skippedCount: 0,
          restartMode: 'graceful',
          restartReason: 'overlap'
        })
      })
    ]);
  });

  it('applies catch_up_all by replaying all due interval occurrences deterministically', () => {
    const scheduler = createInMemorySchedulerPluginV1();

    scheduler.schedule({
      id: 'trigger-catch-all',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:01.000Z',
      metadata: { intervalMs: 1000 },
      policy: {
        restart: { mode: 'force', reason: 'restart for overlap' },
        misfire: { mode: 'catch_up_all' }
      }
    });

    const drained = scheduler.drainDue('2026-01-01T00:00:04.000Z');
    expect(drained.map((entry) => entry.id)).toEqual([
      'trigger-catch-all:exec:1',
      'trigger-catch-all:exec:2',
      'trigger-catch-all:exec:3',
      'trigger-catch-all:exec:4'
    ]);
    expect(drained.map((entry) => entry.execution?.scheduledFor)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z'
    ]);
    expect(scheduler.listScheduled().map((entry) => entry.id)).toEqual(['trigger-catch-all']);
    expect(scheduler.listScheduled()[0]?.runAt).toBe('2026-01-01T00:00:05.000Z');
    expect(scheduler.listPolicyOutcomes()).toEqual([
      expect.objectContaining({
        triggerId: 'trigger-catch-all',
        outcome: expect.objectContaining({
          misfireMode: 'catch_up_all',
          wasMisfire: true,
          dueCount: 4,
          executedCount: 4,
          skippedCount: 0,
          restartMode: 'force',
          restartReason: 'restart for overlap',
          nextRunAt: '2026-01-01T00:00:05.000Z'
        })
      })
    ]);
  });

  it('applies catch_up_bounded by limiting replay to configured maximum', () => {
    const scheduler = createInMemorySchedulerPluginV1();

    scheduler.schedule({
      id: 'trigger-catch-bounded',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:01.000Z',
      metadata: { intervalMs: 1000 },
      policy: {
        misfire: { mode: 'catch_up_bounded', maxCatchUpCount: 2 }
      }
    });

    const drained = scheduler.drainDue('2026-01-01T00:00:04.000Z');
    expect(drained.map((entry) => entry.id)).toEqual([
      'trigger-catch-bounded:exec:1',
      'trigger-catch-bounded:exec:2'
    ]);
    expect(drained.map((entry) => entry.execution?.scheduledFor)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z'
    ]);
    expect(scheduler.listPolicyOutcomes()).toEqual([
      expect.objectContaining({
        triggerId: 'trigger-catch-bounded',
        outcome: expect.objectContaining({
          misfireMode: 'catch_up_bounded',
          dueCount: 4,
          executedCount: 2,
          skippedCount: 2,
          nextRunAt: '2026-01-01T00:00:05.000Z'
        })
      })
    ]);
  });

  it('applies latest_only by executing only the latest due occurrence', () => {
    const scheduler = createInMemorySchedulerPluginV1();

    scheduler.schedule({
      id: 'trigger-latest-only',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:01.000Z',
      metadata: { intervalMs: 1000 },
      policy: {
        misfire: { mode: 'latest_only' }
      }
    });

    const drained = scheduler.drainDue('2026-01-01T00:00:04.000Z');
    expect(drained.map((entry) => entry.id)).toEqual(['trigger-latest-only']);
    expect(drained.map((entry) => entry.execution?.scheduledFor)).toEqual(['2026-01-01T00:00:04.000Z']);
    expect(scheduler.listPolicyOutcomes()).toEqual([
      expect.objectContaining({
        triggerId: 'trigger-latest-only',
        outcome: expect.objectContaining({
          misfireMode: 'latest_only',
          dueCount: 4,
          executedCount: 1,
          skippedCount: 3,
          nextRunAt: '2026-01-01T00:00:05.000Z'
        })
      })
    ]);
  });

  it('applies skip_until_next by dropping due occurrences and advancing schedule', () => {
    const scheduler = createInMemorySchedulerPluginV1();

    scheduler.schedule({
      id: 'trigger-skip-next',
      sagaId: 'saga-777',
      runAt: '2026-01-01T00:00:01.000Z',
      metadata: { intervalMs: 1000 },
      policy: {
        misfire: { mode: 'skip_until_next' }
      }
    });

    const drained = scheduler.drainDue('2026-01-01T00:00:04.000Z');
    expect(drained).toEqual([]);
    expect(scheduler.listScheduled().map((entry) => entry.id)).toEqual(['trigger-skip-next']);
    expect(scheduler.listScheduled()[0]?.runAt).toBe('2026-01-01T00:00:05.000Z');
    expect(scheduler.listPolicyOutcomes()).toEqual([
      expect.objectContaining({
        triggerId: 'trigger-skip-next',
        outcome: expect.objectContaining({
          misfireMode: 'skip_until_next',
          dueCount: 4,
          executedCount: 0,
          skippedCount: 4,
          nextRunAt: '2026-01-01T00:00:05.000Z'
        })
      })
    ]);
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
