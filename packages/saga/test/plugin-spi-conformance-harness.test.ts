import { describe, expect, it } from '@jest/globals';
import {
  runSagaErrorHandler,
  runSagaHandler,
  runSagaResponseHandler,
  type SagaIntent,
  type SagaAggregateEventByName,
  type SagaDefinition,
  type TErrorToken,
  type TResponseToken
} from '../src/createSaga';
import {
  ConformanceAggregate,
  EffectsPlugin,
  PersistencePlugin,
  SchedulerPlugin,
  TelemetryPlugin,
  buildTenantFixture,
  conformanceEventForTenant,
  createPluginSpiConformanceSaga,
  pluginBindings,
  type PluginSpiConformanceState
} from './plugin-spi-conformance.fixtures';

const asIntents = (intents: readonly SagaIntent[]) => intents as readonly Record<string, unknown>[];

describe('plugin SPI conformance harness', () => {
  it('validates persistence/scheduler/effects/telemetry action contract emission', async () => {
    const saga = createPluginSpiConformanceSaga();
    const tenant = buildTenantFixture('tenant-a');

    const output = await runSagaHandler(
      { attempts: 0 } as PluginSpiConformanceState,
      conformanceEventForTenant(tenant.tenantId, 'workflow-a', 'cp-a'),
      saga.handlers[0]!.handlers.started,
      tenant.metadata,
      pluginBindings,
      [PersistencePlugin, SchedulerPlugin, EffectsPlugin, TelemetryPlugin] as const
    );

    expect(output.state.attempts).toBe(1);

    const intents = asIntents(output.intents);
    expect(intents).toHaveLength(4);

    expect(intents[0]).toMatchObject({
      type: 'plugin-request',
      plugin_key: 'persistence',
      action_name: 'saveState',
      action_kind: 'request_response',
      execution_payload: {
        workflowId: 'workflow-a',
        checkpoint: 'cp-a',
        tenantId: tenant.tenantId,
        consistency: 'strict'
      },
      routing_metadata: {
        response_handler_key: 'persistence.save.ok',
        error_handler_key: 'persistence.save.failed',
        handler_data: {
          tenantId: tenant.tenantId,
          workflowId: 'workflow-a'
        }
      },
      metadata: tenant.metadata
    });

    expect(intents[1]).toMatchObject({
      type: 'plugin-one-way',
      plugin_key: 'scheduler',
      action_name: 'enqueue',
      execution_payload: {
        id: 'retry:workflow-a',
        delayMs: 1_000,
        tenantId: tenant.tenantId
      },
      metadata: tenant.metadata
    });

    expect(intents[2]).toMatchObject({
      type: 'plugin-one-way',
      plugin_key: 'effects',
      action_name: 'emit',
      execution_payload: {
        type: 'notify',
        payload: {
          workflowId: 'workflow-a',
          checkpoint: 'cp-a'
        },
        tenantId: tenant.tenantId
      },
      metadata: tenant.metadata
    });

    expect(intents[3]).toMatchObject({
      type: 'plugin-one-way',
      plugin_key: 'telemetry',
      action_name: 'record',
      execution_payload: {
        name: 'conformance.started',
        value: 1,
        tenantId: tenant.tenantId
      },
      metadata: tenant.metadata
    });
  });

  it('validates response-handler tenant context propagation semantics', async () => {
    const saga = createPluginSpiConformanceSaga();
    const tenant = buildTenantFixture('tenant-b');

    const response = await runSagaResponseHandler({
      definition: saga,
      state: { attempts: 0 },
      plugins: [PersistencePlugin, SchedulerPlugin, EffectsPlugin, TelemetryPlugin] as const,
      envelope: {
        token: 'persistence.save.ok' as TResponseToken<'persistence.save.ok'>,
        payload: { persisted: true },
        request: {
          plugin_key: 'persistence',
          action_name: 'saveState',
          sagaId: tenant.metadata.sagaId,
          correlationId: tenant.metadata.correlationId,
          causationId: tenant.metadata.causationId
        }
      }
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      return;
    }

    expect(response.output.state).toEqual({
      attempts: 1,
      lastResult: '[object Object]'
    });

    expect(response.output.intents).toEqual([
      {
        type: 'plugin-one-way',
        plugin_key: 'scheduler',
        action_name: 'enqueue',
        action_kind: 'void',
        execution_payload: {
          id: 'next-step',
          delayMs: 500,
          tenantId: tenant.metadata.sagaId
        },
        metadata: tenant.metadata
      }
    ]);
  });

  it('validates error-handler tenant context propagation semantics', async () => {
    const saga = createPluginSpiConformanceSaga();
    const tenant = buildTenantFixture('tenant-c');

    const failure = await runSagaErrorHandler({
      definition: saga,
      state: { attempts: 0 },
      plugins: [PersistencePlugin, SchedulerPlugin, EffectsPlugin, TelemetryPlugin] as const,
      envelope: {
        token: 'persistence.save.failed' as TErrorToken<'persistence.save.failed'>,
        error: { message: 'write-timeout' },
        request: {
          plugin_key: 'persistence',
          action_name: 'saveState',
          sagaId: tenant.metadata.sagaId,
          correlationId: tenant.metadata.correlationId,
          causationId: tenant.metadata.causationId
        }
      }
    });

    expect(failure.ok).toBe(true);
    if (!failure.ok) {
      return;
    }

    expect(failure.output.state).toEqual({
      attempts: 1,
      lastError: '[object Object]'
    });

    expect(failure.output.intents).toEqual([
      {
        type: 'plugin-one-way',
        plugin_key: 'telemetry',
        action_name: 'record',
        action_kind: 'void',
        execution_payload: {
          name: 'persistence_failure',
          value: 1,
          tenantId: tenant.metadata.sagaId
        },
        metadata: tenant.metadata
      }
    ]);
  });

  it('validates executable handler failure semantics for undefined tokens', async () => {
    const saga = createPluginSpiConformanceSaga();
    const untypedSaga = saga as unknown as SagaDefinition<PluginSpiConformanceState, readonly [], any>;

    const responseFailure = await runSagaResponseHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'persistence.save.unknown' as unknown as TResponseToken<string>,
        payload: { persisted: false },
        request: {
          plugin_key: 'persistence',
          action_name: 'saveState'
        }
      }
    });

    expect(responseFailure).toEqual({
      ok: false,
      reason: 'token_not_defined',
      token: 'persistence.save.unknown'
    });

    const errorFailure = await runSagaErrorHandler({
      definition: untypedSaga,
      state: { attempts: 0 },
      envelope: {
        token: 'persistence.save.unknown' as unknown as TErrorToken<string>,
        error: { message: 'ignored' },
        request: {
          plugin_key: 'persistence',
          action_name: 'saveState'
        }
      }
    });

    expect(errorFailure).toEqual({
      ok: false,
      reason: 'token_not_defined',
      token: 'persistence.save.unknown'
    });
  });

  it('keeps conformance aggregate payload contract stable', () => {
    const event: SagaAggregateEventByName<typeof ConformanceAggregate, 'started'> = {
      type: 'conformance.started.event',
      payload: {
        tenantId: 'tenant-stable',
        workflowId: 'workflow-stable',
        checkpoint: 'cp-stable'
      }
    };

    expect(event.payload).toEqual({
      tenantId: 'tenant-stable',
      workflowId: 'workflow-stable',
      checkpoint: 'cp-stable'
    });
  });
});
