declare const require: (id: string) => any;
import {
  emitCanonicalInspection,
  resolveInspectionCausationId,
  resolveInspectionCorrelationId,
  type InspectionEventPublisher
} from '@redemeine/kernel';
import { createTelemetryFacade } from '@redemeine/otel';

const sagaPackage = require('@redemeine/saga');
const runSagaHandler = sagaPackage.runSagaHandler as (
  state: unknown,
  event: unknown,
  handler: (...args: unknown[]) => unknown,
  metadata: SagaIntentMetadata,
  responseHandlers?: SagaResponseHandlerTokenBindings,
  plugins?: readonly unknown[]
) => Promise<{ state: unknown; intents: SagaIntent[] }>;
import {
  createReferenceAdaptersV1,
  runReferenceAdapterFlowV1,
  type SagaIntent as RuntimeSagaIntent,
  type SagaRuntimeReferenceAdapters,
  type SagaRuntimeReferenceFlowResult,
  type SagaSchedulerTriggerPolicyContract
} from './referenceAdapters';
import {
  createSagaAggregate,
  type SagaAggregate,
  type SagaAggregateState
} from './SagaAggregate';

interface SagaIntentMetadata {
  readonly sagaId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

type SagaIntent = RuntimeSagaIntent;

export type SagaResponseHandlerTokenBindings = Record<string, { phase: 'response' | 'error' | 'retry' }>;

export interface SagaDefinitionLike<TState> {
  readonly sagaType: string;
  readonly initialState: () => TState;
  readonly responseHandlers: Record<string, unknown>;
  readonly errorHandlers: Record<string, unknown>;
  readonly retryHandlers: Record<string, unknown>;
  readonly handlers: Array<{
    readonly aggregateType: string;
    readonly handlers: Record<string, (...args: unknown[]) => unknown>;
  }>;
}

export interface SagaBridgeDomainEvent<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly eventId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly occurredAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SagaExecutionBridgeDispatchInput<TPayload = unknown> {
  readonly sagaId: string;
  readonly event: SagaBridgeDomainEvent<TPayload>;
  readonly sagaType?: string;
  readonly intentMetadata?: Partial<SagaIntentMetadata>;
  readonly schedulerPolicy?: SagaSchedulerTriggerPolicyContract;
  readonly nowIso?: string;
}

export interface SagaExecutionBridgeDispatchResult<TState> {
  readonly sagaId: string;
  readonly handled: boolean;
  readonly matchedHandlers: readonly string[];
  readonly intents: readonly SagaIntent[];
  readonly adapterResults: readonly SagaRuntimeReferenceFlowResult[];
  readonly sagaState: TState | undefined;
  readonly aggregateState: SagaAggregateState;
}

export interface CreateSagaExecutionBridgeOptions<TState> {
  readonly definition: SagaDefinitionLike<TState>;
  readonly runtimePlugins?: readonly unknown[];
  readonly sagaAggregate?: SagaAggregate;
  readonly adapters?: SagaRuntimeReferenceAdapters;
  readonly getSagaState?: (sagaId: string) => TState | undefined;
  readonly setSagaState?: (sagaId: string, state: TState) => void;
  readonly getAggregateState?: (sagaId: string) => SagaAggregateState | undefined;
  readonly setAggregateState?: (sagaId: string, state: SagaAggregateState) => void;
  readonly inspection?: InspectionEventPublisher;
  readonly telemetryAdapterId?: string;
}

type RuntimeSagaHandler<TState> = (
  state: TState,
  event: unknown,
  ctx: unknown
) => unknown;

type RuntimeHandlerMatch<TState> = {
  readonly key: string;
  readonly handler: RuntimeSagaHandler<TState>;
};

const createTokenBindings = (
  definition: SagaDefinitionLike<unknown>
): SagaResponseHandlerTokenBindings => {
  const bindings: Record<string, { phase: 'response' | 'error' | 'retry' }> = {};

  for (const token of Object.keys(definition.responseHandlers ?? {})) {
    bindings[token] = { phase: 'response' };
  }

  for (const token of Object.keys(definition.errorHandlers ?? {})) {
    bindings[token] = { phase: 'error' };
  }

  for (const token of Object.keys(definition.retryHandlers ?? {})) {
    bindings[token] = { phase: 'retry' };
  }

  return bindings;
};

const toCamelCase = (value: string): string => value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const resolveAggregateType = (event: SagaBridgeDomainEvent): string | undefined => {
  if (event.aggregateType) {
    return event.aggregateType;
  }

  const [aggregateType] = event.type.split('.');
  return aggregateType;
};

const resolveHandlerKeys = (eventType: string, aggregateType?: string): readonly string[] => {
  const keys = new Set<string>();
  keys.add(eventType);

  const parts = eventType.split('.');
  if (parts.length >= 3 && parts[parts.length - 1] === 'event') {
    const normalized = parts[parts.length - 2] ?? eventType;
    keys.add(normalized);
    keys.add(toCamelCase(normalized));
  }

  if (aggregateType && eventType.startsWith(`${aggregateType}.`) && eventType.endsWith('.event')) {
    const normalized = eventType.slice(aggregateType.length + 1, -'.event'.length);
    keys.add(normalized);
    keys.add(toCamelCase(normalized));
  }

  return Array.from(keys);
};

const isSideEffectIntent = (intent: SagaIntent): boolean => (
  intent.type === 'plugin-one-way'
  || intent.type === 'plugin-request'
  || intent.type === 'plugin-intent'
  || intent.type === 'run-activity'
);

type RawSagaPluginIntent = {
  readonly type: 'plugin-intent';
  readonly plugin_key: string;
  readonly action_name: string;
  readonly interaction: 'fire_and_forget' | 'request_response';
  readonly execution_payload: unknown;
  readonly routing_metadata?: {
    readonly response_handler_key: string;
    readonly error_handler_key: string;
    readonly handler_data: unknown;
    readonly retry_handler_key?: string;
  };
  readonly metadata: SagaIntentMetadata;
};

type RawSagaCoreActivityIntent = {
  readonly type: 'plugin-intent';
  readonly plugin_key: 'core';
  readonly action_name: 'runActivity';
  readonly interaction: 'fire_and_forget';
  readonly execution_payload: {
    readonly name: string;
    readonly closure: () => unknown;
  };
  readonly metadata: SagaIntentMetadata;
};

const asRuntimeIntent = (intent: unknown): SagaIntent => {
  if (!intent || typeof intent !== 'object') {
    return intent as SagaIntent;
  }

  const raw = intent as RawSagaPluginIntent;
  if (raw.type !== 'plugin-intent') {
    return intent as SagaIntent;
  }

  if (raw.interaction === 'request_response') {
    return {
      type: 'plugin-request',
      plugin_key: raw.plugin_key,
      action_name: raw.action_name,
      action_kind: 'request_response',
      execution_payload: raw.execution_payload,
      routing_metadata: raw.routing_metadata ?? {
        response_handler_key: `${raw.plugin_key}.${raw.action_name}.ok`,
        error_handler_key: `${raw.plugin_key}.${raw.action_name}.failed`,
        handler_data: null
      },
      metadata: raw.metadata
    };
  }

  if (raw.plugin_key === 'core' && raw.action_name === 'runActivity') {
    const activityIntent = raw as unknown as RawSagaCoreActivityIntent;
    return {
      type: 'run-activity',
      name: activityIntent.execution_payload.name,
      closure: activityIntent.execution_payload.closure,
      metadata: raw.metadata
    };
  }

  return {
    type: 'plugin-one-way',
    plugin_key: raw.plugin_key,
    action_name: raw.action_name,
    action_kind: 'void',
    execution_payload: raw.execution_payload,
    metadata: raw.metadata
  };
};

export function createSagaExecutionBridge<TState>(
  options: CreateSagaExecutionBridgeOptions<TState>
): {
  readonly adapters: SagaRuntimeReferenceAdapters;
  getSagaState: (sagaId: string) => TState | undefined;
  getAggregateState: (sagaId: string) => SagaAggregateState;
  dispatch: (input: SagaExecutionBridgeDispatchInput) => Promise<SagaExecutionBridgeDispatchResult<TState>>;
} {
  const sagaAggregate = options.sagaAggregate ?? createSagaAggregate({ aggregateName: 'saga' });
  const telemetry = createTelemetryFacade(options.telemetryAdapterId);
  const adapters = options.adapters ?? createReferenceAdaptersV1();
  const tokenBindings = createTokenBindings(options.definition as SagaDefinitionLike<unknown>);

  const sagaStateById = new Map<string, TState>();
  const aggregateStateById = new Map<string, SagaAggregateState>();
  const intentSequenceBySaga = new Map<string, number>();

  const getSagaState = (sagaId: string): TState | undefined => sagaStateById.get(sagaId) ?? options.getSagaState?.(sagaId);

  const setSagaState = (sagaId: string, state: TState): void => {
    sagaStateById.set(sagaId, state);
    options.setSagaState?.(sagaId, state);
  };

  const getAggregateState = (sagaId: string): SagaAggregateState => {
    return aggregateStateById.get(sagaId)
      ?? options.getAggregateState?.(sagaId)
      ?? sagaAggregate.initialState;
  };

  const setAggregateState = (sagaId: string, state: SagaAggregateState): void => {
    aggregateStateById.set(sagaId, state);
    options.setAggregateState?.(sagaId, state);
  };

  const applyAggregateCommand = (sagaId: string, command: { type: string; payload: unknown }): SagaAggregateState => {
    const currentState = getAggregateState(sagaId);
    const events = sagaAggregate.process(currentState, command);

    let nextState = currentState;
    for (const event of events) {
      nextState = sagaAggregate.apply(nextState, event);
    }

    setAggregateState(sagaId, nextState);
    return nextState;
  };

  const ensureAggregateInstance = (sagaId: string, sagaType: string): SagaAggregateState => {
    const current = getAggregateState(sagaId);
    if (current.id) {
      return current;
    }

    return applyAggregateCommand(
      sagaId,
      sagaAggregate.commandCreators.createInstance({
        id: sagaId,
        sagaType,
        createdAt: new Date().toISOString()
      })
    );
  };

  const nextIntentId = (sagaId: string): string => {
    const next = (intentSequenceBySaga.get(sagaId) ?? 0) + 1;
    intentSequenceBySaga.set(sagaId, next);
    return `${sagaId}:intent:${next}`;
  };

  const resolveMetadata = (
    sagaId: string,
    event: SagaBridgeDomainEvent,
    override?: Partial<SagaIntentMetadata>
  ): SagaIntentMetadata => ({
    sagaId: override?.sagaId ?? sagaId,
    correlationId: override?.correlationId
      ?? event.correlationId
      ?? (typeof event.metadata?.correlationId === 'string' ? event.metadata.correlationId : undefined)
      ?? `${sagaId}:correlation`,
    causationId: override?.causationId
      ?? event.causationId
      ?? event.eventId
      ?? (typeof event.metadata?.eventId === 'string' ? event.metadata.eventId : undefined)
      ?? `${sagaId}:causation`
  });

  const resolveMatches = (event: SagaBridgeDomainEvent): readonly RuntimeHandlerMatch<TState>[] => {
    const aggregateType = resolveAggregateType(event);
    if (!aggregateType) {
      return [];
    }

    const candidates = resolveHandlerKeys(event.type, aggregateType);
    const matches: RuntimeHandlerMatch<TState>[] = [];

    for (const group of options.definition.handlers) {
      if (group.aggregateType !== aggregateType) {
        continue;
      }

      for (const key of candidates) {
        const handler = group.handlers[key] as RuntimeSagaHandler<TState> | undefined;
        if (!handler) {
          continue;
        }

        matches.push({ key, handler });
      }
    }

    return matches;
  };

  return {
    adapters,
    getSagaState,
    getAggregateState,
    async dispatch(input): Promise<SagaExecutionBridgeDispatchResult<TState>> {
      const matches = resolveMatches(input.event);
      if (matches.length === 0) {
        return {
          sagaId: input.sagaId,
          handled: false,
          matchedHandlers: [],
          intents: [],
          adapterResults: [],
          sagaState: getSagaState(input.sagaId),
          aggregateState: getAggregateState(input.sagaId)
        };
      }

      const metadata = resolveMetadata(input.sagaId, input.event, input.intentMetadata);
      const inspectionContext = telemetry.extract({
        correlationId: metadata.correlationId,
        causationId: metadata.causationId
      });
      const inspectionCarrier = telemetry.inject(inspectionContext, {});
      ensureAggregateInstance(input.sagaId, input.sagaType ?? options.definition.sagaType);

      applyAggregateCommand(
        input.sagaId,
        sagaAggregate.commandCreators.observeSourceEvent({
          eventType: input.event.type,
          aggregateType: resolveAggregateType(input.event),
          aggregateId: input.event.aggregateId,
          eventId: input.event.eventId,
          sequence: input.event.sequence,
          correlationId: metadata.correlationId,
          causationId: metadata.causationId,
          observedAt: input.event.occurredAt,
          payload: input.event.payload,
          metadata: input.event.metadata
        })
      );

      await emitCanonicalInspection(options.inspection, {
        hook: 'source_event.observed',
        runtime: 'saga-runtime',
        boundary: 'saga.ingress',
        ids: {
          sagaId: input.sagaId,
          aggregateId: input.event.aggregateId,
          aggregateType: input.event.aggregateType,
          eventType: input.event.type,
          eventId: resolveInspectionCausationId(input.event.eventId),
          correlationId: resolveInspectionCorrelationId(metadata.correlationId, `${input.sagaId}:${input.event.type}:source_event.observed`),
          causationId: resolveInspectionCausationId(metadata.causationId, input.event.eventId)
        },
        payload: {
          handlerCount: matches.length,
          hasMetadata: input.event.metadata !== undefined,
          telemetry: {
            mode: telemetry.isNoop ? 'fallback' : 'adapter',
            extractedContext: inspectionContext.values ?? {},
            propagatedCarrier: inspectionCarrier
          }
        },
        compatibility: {
          legacyHook: 'runtime.telemetry',
          legacyContext: {
            kind: 'source_event.observed',
            eventType: input.event.type,
            sagaId: input.sagaId
          }
        }
      });

      const intents: SagaIntent[] = [];
      const adapterResults: SagaRuntimeReferenceFlowResult[] = [];
      let state = getSagaState(input.sagaId) ?? options.definition.initialState();

      for (const match of matches) {
        const output = await runSagaHandler(
          state,
          input.event as any,
          match.handler as any,
          metadata,
          tokenBindings,
          options.runtimePlugins ?? []
        );

        state = output.state as TState;
        setSagaState(input.sagaId, state);

        const runtimeIntents = output.intents.map((intent) => asRuntimeIntent(intent));
        intents.push(...runtimeIntents);

        const executionIdentityByIntentIndex = new Map<number, { executionId: string; intentId: string }>();

        for (let intentIndex = 0; intentIndex < runtimeIntents.length; intentIndex += 1) {
          const intent = runtimeIntents[intentIndex];
          const lifecycleIntentId = nextIntentId(input.sagaId);

          if (isSideEffectIntent(intent)) {
            executionIdentityByIntentIndex.set(intentIndex, {
              executionId: lifecycleIntentId,
              intentId: lifecycleIntentId
            });
          }

          applyAggregateCommand(
            input.sagaId,
            sagaAggregate.commandCreators.recordIntentLifecycle({
              intentId: lifecycleIntentId,
              intentType: intent.type,
              stage: 'created',
              recordedAt: new Date().toISOString(),
              metadata: {
                handler: match.key,
                ...(intent.type === 'plugin-one-way' || intent.type === 'plugin-request' || intent.type === 'plugin-intent'
                  ? { pluginKey: intent.plugin_key, actionName: intent.action_name }
                  : {})
              }
            })
          );
        }

        const adapterResult = await runReferenceAdapterFlowV1(adapters, {
          sagaId: input.sagaId,
          intents: runtimeIntents,
          schedulerPolicy: input.schedulerPolicy,
          nowIso: input.nowIso,
          inspection: options.inspection,
          telemetryAdapterId: options.telemetryAdapterId,
          resolveExecutionIdentity: ({ intentIndex }) => executionIdentityByIntentIndex.get(intentIndex)
        });
        adapterResults.push(adapterResult);
      }

      return {
        sagaId: input.sagaId,
        handled: true,
        matchedHandlers: matches.map((match) => match.key),
        intents,
        adapterResults,
        sagaState: state,
        aggregateState: getAggregateState(input.sagaId)
      };
    }
  };
}
