import {
  createSaga,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  type SagaAggregateEventByName,
  type SagaIntentMetadata
} from '../src/createSaga';
import type { SagaIdentityInput as CanonicalSagaIdentityInput } from '../src/identity';

export type PluginSpiConformanceState = {
  attempts: number;
  lastResult?: string;
  lastError?: string;
};

export type TenantFixture = {
  tenantId: string;
  metadata: SagaIntentMetadata;
};

export const conformanceIdentity: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'spi_conformance_harness',
  version: 1
};

export const ConformanceAggregate = {
  aggregateType: 'conformance',
  pure: {
    eventProjectors: {
      started: (
        _state: unknown,
        _event: {
          payload: { tenantId: string; workflowId: string; checkpoint: string };
        }
      ) => undefined
    }
  },
  commandCreators: {}
} as const;

export const PersistencePlugin = defineSagaPlugin({
  plugin_key: 'persistence',
  actions: {
    saveState: defineRequestResponse((record: { workflowId: string; checkpoint: string; tenantId: string }) => ({
      ...record,
      consistency: 'strict' as const
    }))
  }
});

export const SchedulerPlugin = defineSagaPlugin({
  plugin_key: 'scheduler',
  actions: {
    enqueue: defineOneWay((job: { id: string; delayMs: number; tenantId: string }) => job)
  }
});

export const EffectsPlugin = defineSagaPlugin({
  plugin_key: 'effects',
  actions: {
    emit: defineOneWay((effect: { type: string; payload: Record<string, unknown>; tenantId: string }) => effect)
  }
});

export const TelemetryPlugin = defineSagaPlugin({
  plugin_key: 'telemetry',
  actions: {
    record: defineOneWay((metric: { name: string; value: number; tenantId: string }) => metric)
  }
});

export const pluginBindings = {
  'persistence.save.ok': { phase: 'response' },
  'persistence.save.failed': { phase: 'error' },
  'persistence.save.retry': { phase: 'retry' }
} as const;

export const buildTenantFixture = (tenantId: string): TenantFixture => ({
  tenantId,
  metadata: {
    sagaId: `tenant:${tenantId}:saga:spi`,
    correlationId: `tenant:${tenantId}:corr:spi`,
    causationId: `tenant:${tenantId}:cause:spi`
  }
});

export const conformanceEventForTenant = (
  tenantId: string,
  workflowId = 'workflow-1',
  checkpoint = 'checkpoint-1'
): SagaAggregateEventByName<typeof ConformanceAggregate, 'started'> => ({
  type: 'conformance.started.event',
  payload: {
    tenantId,
    workflowId,
    checkpoint
  }
});

export const createPluginSpiConformanceSaga = () => createSaga({
  identity: conformanceIdentity,
  plugins: [PersistencePlugin, SchedulerPlugin, EffectsPlugin, TelemetryPlugin] as const
})
  .initialState((): PluginSpiConformanceState => ({ attempts: 0 }))
  .onResponses({
    'persistence.save.ok': (state, response, ctx) => {
      state.attempts += 1;
      state.lastResult = String(response.payload);
      ctx.actions.scheduler.enqueue({
        id: 'next-step',
        delayMs: 500,
        tenantId: response.request.sagaId ?? 'unknown-tenant'
      });
    }
  })
  .onErrors({
    'persistence.save.failed': (state, error, ctx) => {
      state.attempts += 1;
      state.lastError = String(error.error);
      ctx.actions.telemetry.record({
        name: 'persistence_failure',
        value: 1,
        tenantId: error.request.sagaId ?? 'unknown-tenant'
      });
    }
  })
  .onRetries({
    'persistence.save.retry': () => undefined
  })
  .on(ConformanceAggregate, {
    started: async (state, event, ctx) => {
      const saveIntent = ctx.actions.persistence
        .saveState({
          workflowId: event.payload.workflowId,
          checkpoint: event.payload.checkpoint,
          tenantId: event.payload.tenantId
        })
        .withData({ tenantId: event.payload.tenantId, workflowId: event.payload.workflowId })
        .onResponse(ctx.onResponse['persistence.save.ok'])
        .onError(ctx.onError['persistence.save.failed']);

      ctx.actions.scheduler.enqueue({
        id: `retry:${event.payload.workflowId}`,
        delayMs: 1_000,
        tenantId: event.payload.tenantId
      });

      ctx.actions.effects.emit({
        type: 'notify',
        payload: {
          workflowId: event.payload.workflowId,
          checkpoint: event.payload.checkpoint
        },
        tenantId: event.payload.tenantId
      });

      ctx.actions.telemetry.record({
        name: 'conformance.started',
        value: 1,
        tenantId: event.payload.tenantId
      });

      state.attempts += 1;

      void saveIntent;
    }
  })
  .build();
