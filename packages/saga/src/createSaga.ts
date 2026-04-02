import { createDraft, finishDraft, type Draft } from 'immer';
import type { SagaRetryPolicy } from './RetryPolicy';

/** Factory used to initialize saga state for a new saga definition. */
export type SagaInitialStateFactory<TState> = () => TState;

/** Correlation resolver for routing domain events into saga instances. */
export type SagaCorrelationFactory = (...args: unknown[]) => unknown;

type AnyFunction = (...args: any[]) => unknown;

export type SagaPluginActionKind = 'void' | 'request_response';

export type SagaPluginVoidActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> = {
  readonly action_kind: 'void';
  readonly build: TBuild;
  readonly description?: string;
};

export type SagaPluginRequestResponseActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> = {
  readonly action_kind: 'request_response';
  readonly build: TBuild;
  readonly description?: string;
};

export type SagaPluginActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> =
  | SagaPluginVoidActionDescriptor<TBuild>
  | SagaPluginRequestResponseActionDescriptor<TBuild>;

export type SagaPluginActions = Record<string, SagaPluginActionDescriptor>;

export interface SagaPluginManifest<
  TPluginKey extends string = string,
  TActions extends SagaPluginActions = SagaPluginActions
> {
  readonly plugin_key: TPluginKey;
  readonly actions: TActions;
  readonly version?: string;
  readonly description?: string;
}

export type SagaPluginActionBuild<TAction extends SagaPluginActionDescriptor> = TAction['build'];

export type SagaPluginActionArguments<TAction extends SagaPluginActionDescriptor> =
  Parameters<SagaPluginActionBuild<TAction>>;

export type SagaPluginActionExecutionPayload<TAction extends SagaPluginActionDescriptor> =
  ReturnType<SagaPluginActionBuild<TAction>>;

export type SagaPluginActionNamesByKind<
  TPlugin extends SagaPluginManifest,
  TKind extends SagaPluginActionKind
> = {
  [TActionName in keyof TPlugin['actions'] & string]: TPlugin['actions'][TActionName]['action_kind'] extends TKind
    ? TActionName
    : never;
}[keyof TPlugin['actions'] & string];

export type SagaPluginVoidActionNames<TPlugin extends SagaPluginManifest> =
  SagaPluginActionNamesByKind<TPlugin, 'void'>;

export type SagaPluginRequestResponseActionNames<TPlugin extends SagaPluginManifest> =
  SagaPluginActionNamesByKind<TPlugin, 'request_response'>;

export type SagaResponseHandlerPhase = 'response' | 'error';

export interface SagaResponseHandlerTokenBinding<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TPhase extends SagaResponseHandlerPhase = SagaResponseHandlerPhase
> {
  readonly plugin_key: TPluginKey;
  readonly action_name: TActionName;
  readonly phase: TPhase;
}

export type SagaResponseHandlerTokenBindings = Record<string, SagaResponseHandlerTokenBinding>;

type SagaResponseHandlerKeysByPhase<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase
> = {
  [THandlerKey in keyof TBindings & string]: TBindings[THandlerKey]['phase'] extends TPhase
    ? THandlerKey
    : never;
}[keyof TBindings & string];

export type SagaResponseHandlerTokenNamespace<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase
> = {
  readonly [THandlerKey in SagaResponseHandlerKeysByPhase<TBindings, TPhase>]: THandlerKey;
};

export type SagaResponseHandlerTokenAccess<TBindings extends SagaResponseHandlerTokenBindings> = {
  readonly onResponse: SagaResponseHandlerTokenNamespace<TBindings, 'response'>;
  readonly onError: SagaResponseHandlerTokenNamespace<TBindings, 'error'>;
};

/**
 * Helper for authoring plugin manifests with strong literal inference.
 */
export function defineSagaPlugin<
  const TPluginKey extends string,
  const TActions extends SagaPluginActions
>(manifest: {
  readonly plugin_key: TPluginKey;
  readonly actions: TActions;
  readonly version?: string;
  readonly description?: string;
}): SagaPluginManifest<TPluginKey, TActions> {
  return manifest;
}

/** Required metadata attached to every emitted saga intent. */
export interface SagaIntentMetadata {
  sagaId: string;
  correlationId: string;
  causationId: string;
}

/** Typed dispatch intent for a single command entry. */
export type SagaDispatchIntentForCommand<TCommandName extends string = string, TPayload = unknown> = {
  readonly type: 'dispatch';
  readonly command: TCommandName;
  readonly payload: TPayload;
  readonly aggregateId?: string;
  readonly metadata: SagaIntentMetadata;
};

/** Intent that requests delayed saga wake-up scheduling. */
export interface SagaScheduleIntent {
  readonly type: 'schedule';
  readonly id: string;
  readonly delay: number;
  readonly metadata: SagaIntentMetadata;
}

/** Intent that cancels a previously scheduled wake-up. */
export interface SagaCancelScheduleIntent {
  readonly type: 'cancel-schedule';
  readonly id: string;
  readonly metadata: SagaIntentMetadata;
}

/** Function signature used for `run-activity` intent closures. */
export type SagaActivityClosure<TResult = unknown> = () => TResult | Promise<TResult>;

export type SagaPluginManifestList = readonly SagaPluginManifest[];

export type SagaDefinitionPluginKind = 'manifest';

export interface SagaPluginRegistryEntry<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TVersion extends string | undefined = string | undefined
> {
  readonly plugin_key: TPluginKey;
  readonly plugin_kind: SagaDefinitionPluginKind;
  readonly action_names: readonly TActionName[];
  readonly version?: TVersion;
}

export type SagaPluginRegistryEntryFromManifest<TPlugin extends SagaPluginManifest> = SagaPluginRegistryEntry<
  TPlugin['plugin_key'],
  keyof TPlugin['actions'] & string,
  TPlugin['version']
>;

export type SagaPluginRegistryFromManifests<TPlugins extends SagaPluginManifestList> = {
  readonly [TIndex in keyof TPlugins]: TPlugins[TIndex] extends SagaPluginManifest
    ? SagaPluginRegistryEntryFromManifest<TPlugins[TIndex]>
    : never;
};

type SagaResponseHandlerKeysByPhaseForAction<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase,
  TPluginKey extends string,
  TActionName extends string
> = {
  [THandlerKey in keyof TBindings & string]: TBindings[THandlerKey] extends {
    phase: TPhase;
    plugin_key: TPluginKey;
    action_name: TActionName;
  }
    ? THandlerKey
    : never;
}[keyof TBindings & string];

type SagaRequestActionChainWithDataStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings
> = {
  withData: <THandlerData>(
    data: THandlerData
  ) => SagaRequestActionChainOnResponseStep<TPluginKey, TActionName, TExecutionPayload, TBindings, THandlerData>;
};

type SagaRequestActionChainOnResponseStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings,
  THandlerData
> = {
  onResponse: <
    TResponseHandlerKey extends SagaResponseHandlerKeysByPhaseForAction<
      TBindings,
      'response',
      TPluginKey,
      TActionName
    >
  >(
    token: TResponseHandlerKey
  ) => SagaRequestActionChainOnErrorStep<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    TBindings,
    THandlerData,
    TResponseHandlerKey
  >;
};

type SagaRequestActionChainOnErrorStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings,
  THandlerData,
  TResponseHandlerKey extends string
> = {
  onError: <
    TErrorHandlerKey extends SagaResponseHandlerKeysByPhaseForAction<
      TBindings,
      'error',
      TPluginKey,
      TActionName
    >
  >(
    token: TErrorHandlerKey
  ) => SagaPluginRequestIntent<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    SagaPluginRequestRoutingMetadata<TResponseHandlerKey, TErrorHandlerKey, THandlerData>
  >;
};

type SagaPluginActionContextForManifestAction<
  TPluginKey extends string,
  TActionName extends string,
  TAction extends SagaPluginActionDescriptor,
  TBindings extends SagaResponseHandlerTokenBindings
> = TAction['action_kind'] extends 'request_response'
  ? (
      ...args: SagaPluginActionArguments<TAction>
    ) => SagaRequestActionChainWithDataStep<
      TPluginKey,
      TActionName,
      SagaPluginActionExecutionPayload<TAction>,
      TBindings
    >
  : (...args: SagaPluginActionArguments<TAction>) => SagaPluginActionExecutionPayload<TAction>;

type SagaPluginActionsForManifest<
  TPlugin extends SagaPluginManifest,
  TBindings extends SagaResponseHandlerTokenBindings
> = {
  [TActionName in keyof TPlugin['actions'] & string]: SagaPluginActionContextForManifestAction<
    TPlugin['plugin_key'],
    TActionName,
    TPlugin['actions'][TActionName],
    TBindings
  >;
};

export type SagaPluginActionsContext<
  TPlugins extends SagaPluginManifestList = readonly [],
  TBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = {
  [TPlugin in TPlugins[number] as TPlugin['plugin_key']]: SagaPluginActionsForManifest<TPlugin, TBindings>;
};

/** Intent that delegates work to an activity function. */
export interface SagaRunActivityIntent<TResult = unknown> {
  readonly type: 'run-activity';
  readonly name: string;
  readonly closure: SagaActivityClosure<TResult>;
  readonly retryPolicy?: SagaRetryPolicy;
  readonly metadata: SagaIntentMetadata;
}

/** Routing metadata used by plugin request-response intents. */
export interface SagaPluginRequestRoutingMetadata<
  TResponseHandlerKey extends string = string,
  TErrorHandlerKey extends string = string,
  THandlerData = unknown
> {
  readonly response_handler_key: TResponseHandlerKey;
  readonly error_handler_key: TErrorHandlerKey;
  readonly handler_data: THandlerData;
}

/**
 * Intent that requests plugin execution for request-response actions.
 *
 * `execution_payload` is plugin-owned and intentionally opaque to the saga
 * framework. Routing keys and handler data are carried separately in
 * `routing_metadata` for deterministic response/error dispatch.
 */
export interface SagaPluginRequestIntent<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TExecutionPayload = unknown,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata = SagaPluginRequestRoutingMetadata
> {
  readonly type: 'plugin-request';
  readonly plugin_key: TPluginKey;
  readonly action_name: TActionName;
  readonly action_kind: 'request_response';
  readonly execution_payload: TExecutionPayload;
  readonly routing_metadata: TRoutingMetadata;
  readonly metadata: SagaIntentMetadata;
}

/** Full intent union emitted by saga handlers. */
export type SagaIntent =
  | SagaDispatchIntentForCommand<string, unknown>
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent
  | SagaPluginRequestIntent;

/** Command envelope shape emitted by aggregate command creators. */
export interface SagaAggregateCommandEnvelope {
  readonly type: string;
  readonly payload: unknown;
}

/** Command creators shape emitted by `createAggregate(...).build()`. */
export type SagaCommandCreators = Record<string, (...args: any[]) => SagaAggregateCommandEnvelope>;

/** Aggregate definition shape consumed by saga `.on(...)` and `ctx.commandsFor(...)`. */
export interface SagaAggregateDefinition<
  TEventProjectors extends Record<string, AnyFunction> = Record<string, AnyFunction>,
  TCommandCreators extends SagaCommandCreators = SagaCommandCreators,
  TAggregateType extends string = string
> {
  readonly __aggregateType?: TAggregateType;
  readonly pure: {
    readonly eventProjectors: TEventProjectors;
  };
  readonly commandCreators: TCommandCreators;
}

type CommandCreatorsOf<TAggregate extends SagaAggregateDefinition> = TAggregate['commandCreators'];
type EventProjectorsOf<TAggregate extends SagaAggregateDefinition> = TAggregate['pure']['eventProjectors'];

type AggregateTypeOf<TAggregate extends SagaAggregateDefinition> =
  TAggregate extends { __aggregateType: infer TAggregateType extends string }
    ? TAggregateType
    : string;

type ProjectorPayload<TProjector> =
  TProjector extends (state: any, event: infer TEvent, ...args: any[]) => unknown
    ? TEvent extends { payload: infer TPayload }
      ? TPayload
      : unknown
    : unknown;

export type SagaAggregateEventPayloadMap<TAggregate extends SagaAggregateDefinition> = {
  [TEventName in keyof EventProjectorsOf<TAggregate> & string]: ProjectorPayload<EventProjectorsOf<TAggregate>[TEventName]>;
};

export type SagaAggregateEventName<TAggregate extends SagaAggregateDefinition> =
  keyof SagaAggregateEventPayloadMap<TAggregate> & string;

export type SagaAggregateEventByName<
  TAggregate extends SagaAggregateDefinition,
  TEventName extends SagaAggregateEventName<TAggregate>
> = {
  readonly type: TEventName | `${AggregateTypeOf<TAggregate>}.${TEventName}.event`;
  readonly payload: SagaAggregateEventPayloadMap<TAggregate>[TEventName];
  readonly aggregateType?: AggregateTypeOf<TAggregate>;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly metadata?: Record<string, unknown>;
};

type SagaCommandIntentFactoryFromCreator<TCreator, TCommandName extends string> =
  TCreator extends (...args: infer TArgs) => infer TEnvelope
    ? TEnvelope extends { payload: infer TPayload }
      ? (...args: TArgs) => SagaDispatchIntentForCommand<TCommandName, TPayload> & { readonly aggregateId: string }
      : never
    : never;

/** Typed command-intent creators derived from aggregate command creators. */
export type SagaCommandsFor<TAggregate extends SagaAggregateDefinition> = {
  [TCommandName in keyof CommandCreatorsOf<TAggregate> & string]: SagaCommandIntentFactoryFromCreator<
    CommandCreatorsOf<TAggregate>[TCommandName],
    TCommandName
  >;
};

function mergeSagaIntentMetadata(
  base: SagaIntentMetadata,
  override?: Partial<SagaIntentMetadata>
): SagaIntentMetadata {
  return {
    sagaId: override?.sagaId ?? base.sagaId,
    correlationId: override?.correlationId ?? base.correlationId,
    causationId: override?.causationId ?? base.causationId
  };
}

function createSagaDispatchIntentFromEnvelope<TCommandName extends string, TPayload>(
  command: TCommandName,
  envelope: { payload: TPayload },
  metadata: SagaIntentMetadata,
  metadataOverride?: Partial<SagaIntentMetadata>,
  aggregateId?: string
): SagaDispatchIntentForCommand<TCommandName, TPayload> {
  return {
    type: 'dispatch',
    command,
    payload: envelope.payload,
    aggregateId,
    metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
  };
}

/**
 * Typed helper used by saga handlers to target aggregate command creators.
 *
 * Each command call emits a deterministic `dispatch` intent.
 */
export function createSagaCommandsFor<TAggregate extends SagaAggregateDefinition>(
  aggregateDef: TAggregate,
  aggregateId: string,
  metadata: SagaIntentMetadata,
  emitIntent: (intent: SagaIntent) => void,
  metadataOverride?: Partial<SagaIntentMetadata>
): SagaCommandsFor<TAggregate> {
  const commandIntents = {} as SagaCommandsFor<TAggregate>;

  for (const commandName of Object.keys(aggregateDef.commandCreators)) {
    const createCommand = aggregateDef.commandCreators[commandName];

    (commandIntents as Record<string, (...args: any[]) => unknown>)[commandName] = (...args: any[]) => {
      const command = createCommand(...args);
      const intent = createSagaDispatchIntentFromEnvelope(
        commandName as keyof CommandCreatorsOf<TAggregate> & string,
        command,
        metadata,
        metadataOverride,
        aggregateId
      );

      emitIntent(intent);
      return intent;
    };
  }

  return commandIntents;
}

/** Typed helper used by saga handlers to create activity intents. */
export type SagaRunActivity = <TResult = unknown>(
  name: string,
  closure: SagaActivityClosure<TResult>,
  retryPolicy?: SagaRetryPolicy,
  metadata?: Partial<SagaIntentMetadata>
) => SagaRunActivityIntent<TResult>;

/** Alias for aggregate-driven command dispatch helper. */
export type SagaDispatchTo = <TAggregate extends SagaAggregateDefinition>(
  aggregateDef: TAggregate,
  aggregateId: string,
  metadata?: Partial<SagaIntentMetadata>
) => SagaCommandsFor<TAggregate>;

type SagaCoreDispatchBuild = <TAggregate extends SagaAggregateDefinition>(
  aggregateDef: TAggregate,
  aggregateId: string,
  metadata?: Partial<SagaIntentMetadata>
) => SagaCommandsFor<TAggregate>;

type SagaCoreScheduleBuild = (
  id: string,
  delay: number,
  metadata?: Partial<SagaIntentMetadata>
) => SagaScheduleIntent;

type SagaCoreCancelScheduleBuild = (
  id: string,
  metadata?: Partial<SagaIntentMetadata>
) => SagaCancelScheduleIntent;

type SagaCoreRunActivityBuild = <TResult = unknown>(
  name: string,
  closure: SagaActivityClosure<TResult>,
  retryPolicy?: SagaRetryPolicy,
  metadata?: Partial<SagaIntentMetadata>
) => SagaRunActivityIntent<TResult>;

export type SagaCorePluginManifest = SagaPluginManifest<
  'core',
  {
    readonly dispatch: SagaPluginVoidActionDescriptor;
    readonly dispatchTo: SagaPluginVoidActionDescriptor;
    readonly schedule: SagaPluginVoidActionDescriptor;
    readonly cancelSchedule: SagaPluginVoidActionDescriptor;
    readonly runActivity: SagaPluginVoidActionDescriptor;
  }
>;

type SagaCoreActionsContext = {
  readonly dispatch: SagaDispatchTo;
  readonly dispatchTo: SagaDispatchTo;
  readonly schedule: SagaCoreScheduleBuild;
  readonly cancelSchedule: SagaCoreCancelScheduleBuild;
  readonly runActivity: SagaRunActivity;
};

/** Base context exposed to saga handlers for intent emissions. */
export interface SagaIntentContextBase {
  readonly metadata: SagaIntentMetadata;
  readonly intents: readonly SagaIntent[];
  emit: (intent: SagaIntent) => void;
  commandsFor: <TAggregate extends SagaAggregateDefinition>(
    aggregateDef: TAggregate,
    aggregateId: string,
    metadata?: Partial<SagaIntentMetadata>
  ) => SagaCommandsFor<TAggregate>;
  dispatchTo: SagaDispatchTo;
  schedule: (id: string, delay: number, metadata?: Partial<SagaIntentMetadata>) => SagaScheduleIntent;
  cancelSchedule: (id: string, metadata?: Partial<SagaIntentMetadata>) => SagaCancelScheduleIntent;
  runActivity: SagaRunActivity;
}

/**
 * Full context exposed to saga handlers, including plugin action namespace
 * and typed response-handler token namespaces.
 */
export type SagaIntentContext<
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = SagaIntentContextBase & {
  readonly actions: SagaPluginActionsContext<TPlugins, TResponseHandlerBindings> & {
    readonly core: SagaCoreActionsContext;
  };
} & SagaResponseHandlerTokenAccess<TResponseHandlerBindings>;

function createSagaCorePluginManifest(
  metadata: SagaIntentMetadata,
  emitIntent: (intent: SagaIntent) => void
): SagaCorePluginManifest {
  const dispatchBuild: SagaCoreDispatchBuild = (aggregateDef, aggregateId, metadataOverride) => createSagaCommandsFor(
    aggregateDef,
    aggregateId,
    metadata,
    emitIntent,
    metadataOverride
  );

  const runActivityBuild: SagaRunActivity = <TResult = unknown>(
    name: string,
    closure: SagaActivityClosure<TResult>,
    retryPolicy?: SagaRetryPolicy,
    metadataOverride?: Partial<SagaIntentMetadata>
  ) => {
    const intent: SagaRunActivityIntent<TResult> = {
      type: 'run-activity',
      name,
      closure,
      retryPolicy,
      metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
    };

    emitIntent(intent);
    return intent;
  };

  return defineSagaPlugin({
    plugin_key: 'core',
    actions: {
      dispatch: {
        action_kind: 'void',
        build: dispatchBuild,
        description: 'Aggregate command dispatch helper'
      },
      dispatchTo: {
        action_kind: 'void',
        build: dispatchBuild,
        description: 'Alias for aggregate command dispatch helper'
      },
      schedule: {
        action_kind: 'void',
        build: (id, delay, metadataOverride) => {
          const intent: SagaScheduleIntent = {
            type: 'schedule',
            id,
            delay,
            metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
          };

          emitIntent(intent);
          return intent;
        },
        description: 'Schedule delayed saga wake-up'
      },
      cancelSchedule: {
        action_kind: 'void',
        build: (id, metadataOverride) => {
          const intent: SagaCancelScheduleIntent = {
            type: 'cancel-schedule',
            id,
            metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
          };

          emitIntent(intent);
          return intent;
        },
        description: 'Cancel delayed saga wake-up'
      },
      runActivity: {
        action_kind: 'void',
        build: runActivityBuild,
        description: 'Run saga activity closure'
      }
    },
    description: 'Built-in saga side-effect action manifests'
  });
}

function createPluginActionsContext(
  plugins: SagaPluginManifestList,
  metadata: SagaIntentMetadata,
  emitIntent: (intent: SagaIntent) => void
): Record<string, Record<string, (...args: any[]) => unknown>> {
  const actionsContext: Record<string, Record<string, (...args: any[]) => unknown>> = Object.create(null);

  for (const plugin of plugins) {
    const pluginActions: Record<string, (...args: any[]) => unknown> = Object.create(null);

    for (const actionName of Object.keys(plugin.actions)) {
      const actionDescriptor = plugin.actions[actionName];

      if (actionDescriptor.action_kind === 'request_response') {
        pluginActions[actionName] = (...args: any[]) => {
          const executionPayload = actionDescriptor.build(...args);

          return {
            withData: (handlerData: unknown) => ({
              onResponse: (responseHandlerKey: string) => ({
                onError: (errorHandlerKey: string) => {
                  const intent: SagaPluginRequestIntent = {
                    type: 'plugin-request',
                    plugin_key: plugin.plugin_key,
                    action_name: actionName,
                    action_kind: 'request_response',
                    execution_payload: executionPayload,
                    routing_metadata: {
                      response_handler_key: responseHandlerKey,
                      error_handler_key: errorHandlerKey,
                      handler_data: handlerData
                    },
                    metadata
                  };

                  emitIntent(intent);
                  return intent;
                }
              })
            })
          };
        };
        continue;
      }

      pluginActions[actionName] = (...args: any[]) => actionDescriptor.build(...args);
    }

    actionsContext[plugin.plugin_key] = pluginActions;
  }

  return actionsContext;
}

function createResponseHandlerTokenNamespace<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase
>(
  responseHandlers: TBindings,
  phase: TPhase
): SagaResponseHandlerTokenNamespace<TBindings, TPhase> {
  const namespace: Record<string, string> = {};

  for (const handlerKey of Object.keys(responseHandlers)) {
    const binding = responseHandlers[handlerKey];
    if (binding.phase === phase) {
      namespace[handlerKey] = handlerKey;
    }
  }

  return namespace as SagaResponseHandlerTokenNamespace<TBindings, TPhase>;
}

/**
 * Builds runtime saga intent helper implementations for handler execution.
 */
export function createSagaDispatchContext<
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
>(
  metadata: SagaIntentMetadata,
  intents: SagaIntent[] = [],
  responseHandlers: TResponseHandlerBindings = {} as TResponseHandlerBindings,
  plugins: TPlugins = [] as unknown as TPlugins
): SagaIntentContext<TPlugins, TResponseHandlerBindings> {
  const emit = (intent: SagaIntent) => {
    intents.push(intent);
  };

  const onResponse = createResponseHandlerTokenNamespace(responseHandlers, 'response');
  const onError = createResponseHandlerTokenNamespace(responseHandlers, 'error');
  const corePlugin = createSagaCorePluginManifest(metadata, emit);
  const actions = createPluginActionsContext([corePlugin, ...plugins], metadata, emit) as SagaPluginActionsContext<
    TPlugins,
    TResponseHandlerBindings
  > & {
    readonly core: SagaCoreActionsContext;
  };

  return {
    metadata,
    get intents() {
      return intents;
    },
    onResponse,
    onError,
    emit,
    commandsFor: (aggregateDef, aggregateId, metadataOverride) => actions.core.dispatch(
      aggregateDef,
      aggregateId,
      metadataOverride
    ),
    dispatchTo: (aggregateDef, aggregateId, metadataOverride) => actions.core.dispatchTo(
      aggregateDef,
      aggregateId,
      metadataOverride
    ),
    schedule: (id, delay, metadataOverride) => actions.core.schedule(id, delay, metadataOverride),
    cancelSchedule: (id, metadataOverride) => actions.core.cancelSchedule(id, metadataOverride),
    runActivity: <TResult = unknown>(
      name: string,
      closure: SagaActivityClosure<TResult>,
      retryPolicy?: SagaRetryPolicy,
      metadataOverride?: Partial<SagaIntentMetadata>
    ) => actions.core.runActivity(name, closure, retryPolicy, metadataOverride),
    actions
  };
}

/** Deterministic state transition emitted by saga handlers. */
export interface SagaReducerOutput<TState> {
  readonly state: TState;
  readonly intents: readonly SagaIntent[];
}

/** Sync or async saga handler result. */
export type SagaHandlerResult = void | Promise<void>;

/** Saga handler keyed under `.on(<aggregate>, handlers)` entries. */
export type SagaHandler<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TEventName extends SagaAggregateEventName<TAggregate>,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = (
  state: Draft<TState>,
  event: SagaAggregateEventByName<TAggregate, TEventName>,
  ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
) => SagaHandlerResult;

/** Map of handler names to saga reducer functions. */
export type SagaHandlers<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = {
  [TEventName in SagaAggregateEventName<TAggregate>]?: SagaHandler<
    TState,
    TAggregate,
    TEventName,
    TPlugins,
    TResponseHandlerBindings
  >;
};

/** Handler used by trigger-based saga starts before any aggregate events. */
export type SagaStartHandler<
  TStartInput,
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = (
  start: TStartInput,
  ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
) => SagaHandlerResult;

/** Resolver that maps normalized start input to a correlation key. */
export type SagaStartCorrelationResolver<TStartInput, TCorrelationId = unknown> = (
  start: TStartInput
) => TCorrelationId;

/** Normalized trigger contract shape retained in saga definition metadata. */
export interface SagaTriggerContract<
  TStartInput,
  TTriggerInput = unknown,
  TKind extends string = string
> {
  readonly kind: TKind;
  readonly toStartInput: (trigger: TTriggerInput) => TStartInput;
  readonly when?: (trigger: TTriggerInput) => boolean;
  readonly hasWhen: boolean;
}

/** Trigger definition accepted by `.triggeredBy(...)`. */
export interface SagaTriggerDefinition<
  TStartInput,
  TTriggerInput = unknown,
  TKind extends string = string
> {
  readonly kind: TKind;
  readonly toStartInput: (trigger: TTriggerInput) => TStartInput;
  readonly when?: (trigger: TTriggerInput) => boolean;
}

/** Normalized start/correlation/trigger metadata exported on saga definitions. */
export interface SagaStartDslContracts<TStartInput = unknown, TCorrelationId = unknown> {
  readonly start?: {
    readonly kind: 'definition-only';
  };
  readonly correlation?: {
    readonly correlateBy: SagaStartCorrelationResolver<TStartInput, TCorrelationId>;
  };
  readonly triggers: readonly SagaTriggerContract<TStartInput, unknown, string>[];
}

/** Built saga definition consumed by runtime execution layers. */
export interface SagaDefinition<
  TState = unknown,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> {
  name: string;
  identity: SagaIdentityMetadata;
  sagaType: string;
  sagaUrn: string;
  plugins: SagaPluginRegistryFromManifests<TPlugins>;
  initialState: SagaInitialStateFactory<TState>;
  start?: SagaStartHandler<unknown, TState, TPlugins, TResponseHandlerBindings>;
  startContracts: SagaStartDslContracts<unknown, unknown>;
  response_handlers: TResponseHandlerBindings;
  correlations: Array<{
    aggregateType: string;
    sagaType: string;
    sagaUrn: string;
    aggregate: SagaAggregateDefinition;
    correlate: SagaCorrelationFactory;
  }>;
  handlers: Array<{
    aggregateType: string;
    sagaType: string;
    sagaUrn: string;
    aggregate: SagaAggregateDefinition;
    handlers: Record<string, SagaHandler<TState, SagaAggregateDefinition, string, TPlugins, TResponseHandlerBindings>>;
  }>;
}

/** Fluent builder for composing a saga definition. */
export interface SagaBuilder<
  TState = unknown,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> {
  initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>): SagaBuilder<TNextState, TPlugins, TResponseHandlerBindings>;
  responseHandlers<const TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(
    handlers: TNextResponseHandlerBindings
  ): SagaBuilder<TState, TPlugins, TNextResponseHandlerBindings>;
  correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory): SagaBuilder<TState, TPlugins, TResponseHandlerBindings>;
  on<TAggregate extends SagaAggregateDefinition>(
    aggregate: TAggregate,
    handlers: SagaHandlers<TState, TAggregate, TPlugins, TResponseHandlerBindings>
  ): SagaBuilder<TState, TPlugins, TResponseHandlerBindings>;
  start<TStartInput>(
    handler: SagaStartHandler<TStartInput, TState, TPlugins, TResponseHandlerBindings>
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings, TStartInput>;
  build(): SagaDefinition<TState, TPlugins, TResponseHandlerBindings>;
}

/** Builder phase after `start(...)` and before required `correlateBy(...)`. */
export interface SagaBuilderAwaitingCorrelation<
  TState,
  TPlugins extends SagaPluginManifestList,
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings,
  TStartInput
> {
  initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>): SagaBuilderAwaitingCorrelation<TNextState, TPlugins, TResponseHandlerBindings, TStartInput>;
  responseHandlers<const TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(
    handlers: TNextResponseHandlerBindings
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TNextResponseHandlerBindings, TStartInput>;
  correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings, TStartInput>;
  on<TAggregate extends SagaAggregateDefinition>(
    aggregate: TAggregate,
    handlers: SagaHandlers<TState, TAggregate, TPlugins, TResponseHandlerBindings>
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings, TStartInput>;
  correlateBy<TCorrelationId>(
    correlate: SagaStartCorrelationResolver<TStartInput, TCorrelationId>
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings, TStartInput, TCorrelationId>;
}

/** Builder phase after `correlateBy(...)`, where triggers and build are available. */
export interface SagaBuilderCorrelated<
  TState,
  TPlugins extends SagaPluginManifestList,
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings,
  TStartInput,
  TCorrelationId
> {
  initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>): SagaBuilderCorrelated<TNextState, TPlugins, TResponseHandlerBindings, TStartInput, TCorrelationId>;
  responseHandlers<const TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(
    handlers: TNextResponseHandlerBindings
  ): SagaBuilderCorrelated<TState, TPlugins, TNextResponseHandlerBindings, TStartInput, TCorrelationId>;
  correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings, TStartInput, TCorrelationId>;
  on<TAggregate extends SagaAggregateDefinition>(
    aggregate: TAggregate,
    handlers: SagaHandlers<TState, TAggregate, TPlugins, TResponseHandlerBindings>
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings, TStartInput, TCorrelationId>;
  correlateBy<TNextCorrelationId>(
    correlate: SagaStartCorrelationResolver<TStartInput, TNextCorrelationId>
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings, TStartInput, TNextCorrelationId>;
  triggeredBy<TTriggerInput, TKind extends string = string>(
    trigger: SagaTriggerDefinition<TStartInput, TTriggerInput, TKind>
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings, TStartInput, TCorrelationId>;
  build(): SagaDefinition<TState, TPlugins, TResponseHandlerBindings>;
}

export interface CreateSagaOptions<TPlugins extends SagaPluginManifestList = readonly []> {
  name: string;
  identity?: SagaIdentityInput;
  plugins?: TPlugins;
}

export interface SagaIdentityInput {
  namespace?: string;
  name?: string;
  version?: number;
}

export interface SagaIdentityFields {
  namespace: string;
  name: string;
  version: number;
}

export interface SagaIdentityMetadata extends SagaIdentityFields {
  legacyName: string;
  sagaType: string;
  sagaUrn: string;
}

type SagaPluginsFromOptions<TOptions extends CreateSagaOptions<SagaPluginManifestList>> =
  TOptions extends { plugins: infer TPlugins extends SagaPluginManifestList }
    ? TPlugins
    : readonly [];

interface SagaDefinitionDraft<
  TPlugins extends readonly SagaPluginRegistryEntry[] = readonly SagaPluginRegistryEntry[],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = SagaResponseHandlerTokenBindings
> {
  name: string;
  identity: SagaIdentityMetadata;
  sagaType: string;
  sagaUrn: string;
  plugins: TPlugins;
  initialState: SagaInitialStateFactory<unknown>;
  start?: SagaStartHandler<unknown, unknown, SagaPluginManifestList, SagaResponseHandlerTokenBindings>;
  startContracts: SagaStartDslContracts<unknown, unknown>;
  response_handlers: TResponseHandlerBindings;
  correlations: Array<{
    aggregateType: string;
    sagaType: string;
    sagaUrn: string;
    aggregate: SagaAggregateDefinition;
    correlate: SagaCorrelationFactory;
  }>;
  handlers: Array<{
    aggregateType: string;
    sagaType: string;
    sagaUrn: string;
    aggregate: SagaAggregateDefinition;
    handlers: Record<
      string,
      SagaHandler<unknown, SagaAggregateDefinition, string, SagaPluginManifestList, SagaResponseHandlerTokenBindings>
    >;
  }>;
}

function getAggregateType(aggregate: SagaAggregateDefinition): string {
  return aggregate.__aggregateType ?? 'unknown';
}

function normalizeIdentitySegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeIdentityVersion(version: number | undefined): number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    return 1;
  }

  return version;
}

function deriveSagaType(identity: SagaIdentityFields): string {
  return `${identity.namespace}.${identity.name}.v${identity.version}`;
}

function deriveSagaUrn(identity: SagaIdentityFields): string {
  return `urn:redemeine:saga:${identity.namespace}:${identity.name}:v${identity.version}`;
}

function resolveSagaIdentity(options: CreateSagaOptions<SagaPluginManifestList>): SagaIdentityMetadata {
  const legacyName = options.name;
  const namespace = normalizeIdentitySegment(options.identity?.namespace ?? 'legacy', 'legacy');
  const name = normalizeIdentitySegment(options.identity?.name ?? legacyName, 'saga');
  const version = normalizeIdentityVersion(options.identity?.version);
  const base: SagaIdentityFields = {
    namespace,
    name,
    version
  };

  const sagaType = deriveSagaType(base);
  const sagaUrn = deriveSagaUrn(base);

  return {
    ...base,
    legacyName,
    sagaType,
    sagaUrn
  };
}

function createSagaPluginRegistry<TPlugins extends SagaPluginManifestList>(
  plugins: TPlugins
): SagaPluginRegistryFromManifests<TPlugins> {
  return plugins.map((plugin) => ({
    plugin_key: plugin.plugin_key,
    plugin_kind: 'manifest',
    action_names: Object.keys(plugin.actions),
    ...(plugin.version === undefined ? {} : { version: plugin.version })
  })) as SagaPluginRegistryFromManifests<TPlugins>;
}

/**
 * Executes a single saga handler with mutation-first semantics and produces
 * deterministic reducer output.
 */
export async function runSagaHandler<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TEventName extends SagaAggregateEventName<TAggregate>,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
>(
  state: TState,
  event: SagaAggregateEventByName<TAggregate, TEventName>,
  handler: SagaHandler<TState, TAggregate, TEventName, TPlugins, TResponseHandlerBindings>,
  metadata: SagaIntentMetadata,
  responseHandlers: TResponseHandlerBindings = {} as TResponseHandlerBindings,
  plugins: TPlugins = [] as unknown as TPlugins
): Promise<SagaReducerOutput<TState>> {
  const draft = createDraft(state);
  const intentBuffer: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TResponseHandlerBindings>(
    metadata,
    intentBuffer,
    responseHandlers,
    plugins
  );

  await handler(draft, event, ctx);

  return {
    state: finishDraft(draft) as TState,
    intents: intentBuffer
  };
}

function createSagaBuilder<
  TState,
  TPlugins extends SagaPluginManifestList,
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings
>(
  state: SagaDefinitionDraft<
    SagaPluginRegistryFromManifests<TPlugins>,
    TResponseHandlerBindings
  >
): SagaBuilder<TState, TPlugins, TResponseHandlerBindings> {
  const addCorrelation = (aggregate: SagaAggregateDefinition, correlate: SagaCorrelationFactory) => {
    state.correlations.push({
      aggregate,
      aggregateType: getAggregateType(aggregate),
      sagaType: state.sagaType,
      sagaUrn: state.sagaUrn,
      correlate
    });
  };

  const addHandlers = (
    aggregate: SagaAggregateDefinition,
    handlers: Record<
      string,
      SagaHandler<unknown, SagaAggregateDefinition, string, SagaPluginManifestList, SagaResponseHandlerTokenBindings>
    >
  ) => {
    state.handlers.push({
      aggregate,
      aggregateType: getAggregateType(aggregate),
      sagaType: state.sagaType,
      sagaUrn: state.sagaUrn,
      handlers
    });
  };

  const createAwaitingCorrelationBuilder = <
    TLocalState,
    TLocalResponseHandlerBindings extends SagaResponseHandlerTokenBindings,
    TStartInput
  >(): SagaBuilderAwaitingCorrelation<TLocalState, TPlugins, TLocalResponseHandlerBindings, TStartInput> => ({
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createAwaitingCorrelationBuilder<TNextState, TLocalResponseHandlerBindings, TStartInput>();
    },
    responseHandlers<TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(handlers: TNextResponseHandlerBindings) {
      (state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TNextResponseHandlerBindings
      >).response_handlers = handlers;
      return createAwaitingCorrelationBuilder<TLocalState, TNextResponseHandlerBindings, TStartInput>();
    },
    correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory) {
      addCorrelation(aggregate, correlate);
      return createAwaitingCorrelationBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput>();
    },
    on<TAggregate extends SagaAggregateDefinition>(
      aggregate: TAggregate,
      handlers: SagaHandlers<TLocalState, TAggregate, TPlugins, TLocalResponseHandlerBindings>
    ) {
      addHandlers(
        aggregate,
        handlers as Record<
          string,
          SagaHandler<unknown, SagaAggregateDefinition, string, SagaPluginManifestList, SagaResponseHandlerTokenBindings>
        >
      );
      return createAwaitingCorrelationBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput>();
    },
    correlateBy<TCorrelationId>(correlate: SagaStartCorrelationResolver<TStartInput, TCorrelationId>) {
      state.startContracts = {
        ...state.startContracts,
        correlation: {
          correlateBy: correlate as SagaStartCorrelationResolver<unknown, unknown>
        }
      };

      return createCorrelatedBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput, TCorrelationId>();
    }
  });

  const createCorrelatedBuilder = <
    TLocalState,
    TLocalResponseHandlerBindings extends SagaResponseHandlerTokenBindings,
    TStartInput,
    TCorrelationId
  >(): SagaBuilderCorrelated<TLocalState, TPlugins, TLocalResponseHandlerBindings, TStartInput, TCorrelationId> => ({
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createCorrelatedBuilder<TNextState, TLocalResponseHandlerBindings, TStartInput, TCorrelationId>();
    },
    responseHandlers<TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(handlers: TNextResponseHandlerBindings) {
      (state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TNextResponseHandlerBindings
      >).response_handlers = handlers;
      return createCorrelatedBuilder<TLocalState, TNextResponseHandlerBindings, TStartInput, TCorrelationId>();
    },
    correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory) {
      addCorrelation(aggregate, correlate);
      return createCorrelatedBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput, TCorrelationId>();
    },
    on<TAggregate extends SagaAggregateDefinition>(
      aggregate: TAggregate,
      handlers: SagaHandlers<TLocalState, TAggregate, TPlugins, TLocalResponseHandlerBindings>
    ) {
      addHandlers(
        aggregate,
        handlers as Record<
          string,
          SagaHandler<unknown, SagaAggregateDefinition, string, SagaPluginManifestList, SagaResponseHandlerTokenBindings>
        >
      );
      return createCorrelatedBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput, TCorrelationId>();
    },
    correlateBy<TNextCorrelationId>(correlate: SagaStartCorrelationResolver<TStartInput, TNextCorrelationId>) {
      state.startContracts = {
        ...state.startContracts,
        correlation: {
          correlateBy: correlate as SagaStartCorrelationResolver<unknown, unknown>
        }
      };

      return createCorrelatedBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput, TNextCorrelationId>();
    },
    triggeredBy<TTriggerInput, TKind extends string = string>(
      trigger: SagaTriggerDefinition<TStartInput, TTriggerInput, TKind>
    ) {
      const normalizedTrigger: SagaTriggerContract<unknown, unknown, string> = {
        kind: trigger.kind,
        toStartInput: trigger.toStartInput as (trigger: unknown) => unknown,
        when: trigger.when as ((trigger: unknown) => boolean) | undefined,
        hasWhen: typeof trigger.when === 'function'
      };

      state.startContracts = {
        ...state.startContracts,
        triggers: [...state.startContracts.triggers, normalizedTrigger]
      };

      return createCorrelatedBuilder<TLocalState, TLocalResponseHandlerBindings, TStartInput, TCorrelationId>();
    },
    build() {
      return ({
        ...state,
        plugins: [...state.plugins],
        startContracts: {
          ...state.startContracts,
          triggers: [...state.startContracts.triggers]
        },
        response_handlers: { ...state.response_handlers }
      } as unknown) as SagaDefinition<TLocalState, TPlugins, TLocalResponseHandlerBindings>;
    }
  });

  return {
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createSagaBuilder<TNextState, TPlugins, TResponseHandlerBindings>(state);
    },
    responseHandlers<TNextResponseHandlerBindings extends SagaResponseHandlerTokenBindings>(handlers: TNextResponseHandlerBindings) {
      const nextState = {
        ...state,
        response_handlers: handlers
      } as SagaDefinitionDraft<SagaPluginRegistryFromManifests<TPlugins>, TNextResponseHandlerBindings>;

      return createSagaBuilder<TState, TPlugins, TNextResponseHandlerBindings>(nextState);
    },
    correlate(aggregate, correlate) {
      addCorrelation(aggregate, correlate);
      return createSagaBuilder<TState, TPlugins, TResponseHandlerBindings>(state);
    },
    on(aggregate, handlers) {
      addHandlers(
        aggregate,
        handlers as Record<
          string,
          SagaHandler<unknown, SagaAggregateDefinition, string, SagaPluginManifestList, SagaResponseHandlerTokenBindings>
        >
      );
      return createSagaBuilder<TState, TPlugins, TResponseHandlerBindings>(state);
    },
    start<TStartInput>(handler: SagaStartHandler<TStartInput, TState, TPlugins, TResponseHandlerBindings>) {
      state.start = handler as SagaStartHandler<unknown, unknown, SagaPluginManifestList, SagaResponseHandlerTokenBindings>;
      state.startContracts = {
        ...state.startContracts,
        start: {
          kind: 'definition-only'
        }
      };

      return createAwaitingCorrelationBuilder<TState, TResponseHandlerBindings, TStartInput>();
    },
    build() {
      return ({
        ...state,
        plugins: [...state.plugins],
        startContracts: {
          ...state.startContracts,
          triggers: [...state.startContracts.triggers]
        },
        response_handlers: { ...state.response_handlers }
      } as unknown) as SagaDefinition<TState, TPlugins, TResponseHandlerBindings>;
    }
  };
}

/**
 * Creates a fluent saga builder with aggregate-driven typing and mutable
 * handler draft semantics.
 */
export function createSaga<
  TState = unknown,
  const TOptions extends CreateSagaOptions<SagaPluginManifestList> = CreateSagaOptions<readonly []>
>(options: TOptions): SagaBuilder<TState, SagaPluginsFromOptions<TOptions>, Record<never, never>> {
  const pluginManifests = (options.plugins ?? []) as SagaPluginsFromOptions<TOptions>;
  const pluginRegistry = createSagaPluginRegistry(pluginManifests);
  const identity = resolveSagaIdentity(options as CreateSagaOptions<SagaPluginManifestList>);

  const state: SagaDefinitionDraft<
    SagaPluginRegistryFromManifests<SagaPluginsFromOptions<TOptions>>,
    Record<never, never>
  > = {
    name: options.name,
    identity,
    sagaType: identity.sagaType,
    sagaUrn: identity.sagaUrn,
    plugins: pluginRegistry,
    initialState: () => undefined,
    start: undefined,
    startContracts: {
      start: undefined,
      correlation: undefined,
      triggers: []
    },
    response_handlers: {},
    correlations: [],
    handlers: []
  };

  return createSagaBuilder<TState, SagaPluginsFromOptions<TOptions>, Record<never, never>>(state);
}
