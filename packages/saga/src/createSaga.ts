import { createDraft, finishDraft, type Draft } from 'immer';
import {
  normalizeSagaIdentity,
  type SagaIdentityInput
} from './identity';

/** Factory used to initialize saga state for a new saga definition. */
export type SagaInitialStateFactory<TState> = () => TState;

/** Correlation resolver for routing domain events into saga instances. */
export type SagaCorrelationFactory = (...args: unknown[]) => unknown;

type AnyFunction = (...args: any[]) => unknown;
const SAGA_HELPER_EMISSION_MODE = '__saga_helper_emission_mode';

type SagaHelperEmissionMode = 'fire_and_forget' | 'request_response';

export type SagaPluginInteraction = 'fire_and_forget' | 'request_response';

export type SagaPluginFireAndForgetActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> = {
  readonly interaction: 'fire_and_forget';
  readonly build: TBuild;
  readonly description?: string;
};

export type SagaPluginRequestResponseActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> = {
  readonly interaction: 'request_response';
  readonly build: TBuild;
  readonly description?: string;
};

export type SagaPluginActionDescriptor<
  TBuild extends AnyFunction = AnyFunction
> =
  | SagaPluginFireAndForgetActionDescriptor<TBuild>
  | SagaPluginRequestResponseActionDescriptor<TBuild>;

type SagaPluginActionDescriptorWithHelperMetadata = SagaPluginActionDescriptor & {
  readonly [SAGA_HELPER_EMISSION_MODE]?: SagaHelperEmissionMode;
};

type SagaOneWayHelperActionDescriptor<TBuild extends AnyFunction = AnyFunction> =
  SagaPluginFireAndForgetActionDescriptor<TBuild> & {
    readonly [SAGA_HELPER_EMISSION_MODE]: 'fire_and_forget';
  };

type SagaRequestResponseHelperActionDescriptor<TBuild extends AnyFunction = AnyFunction> =
  SagaPluginRequestResponseActionDescriptor<TBuild> & {
    readonly [SAGA_HELPER_EMISSION_MODE]: 'request_response';
  };

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

/**
 * Typed plugin helper API contract (documentation-only for redemeine-7pj.1).
 *
 * These helpers are intentionally not implemented in this step; this block
 * captures the agreed user-facing contract that follow-up implementation work
 * must satisfy.
 *
 * Planned helpers:
 * - `defineOneWay(...)`
 * - `defineRequestResponse(...)`
 * - `defineCustomAction(...)`
 *
 * Contract rules:
 * - `defineOneWay(...)` builds a plugin action that emits immediately and
 *   returns the produced intent in the same handler turn.
 * - `defineRequestResponse(...)` uses a request-response routing chain where
 *   `.withData(...)` is optional, `.onResponse(...)` is required, `.onError(...)`
 *   is required, and `.onRetry(...)` is optional.
 * - `onError` is terminal after retries are exhausted or when an error is
 *   classified as non-retryable.
 * - `defineCustomAction(...)` receives constrained `builderCtx` primitives and
 *   may own completeness semantics for the custom flow.
 *
 * Planned `builderCtx` primitives:
 * - `createPending(...)`
 * - `patch(...)` / `set(...)`
 * - `snapshot(...)`
 * - `finalize(...)` / `emit(...)`
 * - `complete(...)` / `isComplete(...)`
 *
 * Intent emission timing semantics:
 * - One-way helpers emit immediately.
 * - Request-response helpers emit the request intent once routing handlers are
 *   fully bound.
 * - Custom helpers may emit/finalize explicitly via `builderCtx`.
 *
 * Explicitly deferred/out of scope:
 * - Plugin `forCommands` ergonomics are intentionally deferred to a separate
 *   bead and are not part of this contract step.
 */

export type SagaPluginActionBuild<TAction extends SagaPluginActionDescriptor> = TAction['build'];

export type SagaPluginActionArguments<TAction extends SagaPluginActionDescriptor> =
  Parameters<SagaPluginActionBuild<TAction>>;

export type SagaPluginActionExecutionPayload<TAction extends SagaPluginActionDescriptor> =
  ReturnType<SagaPluginActionBuild<TAction>>;

export type SagaPluginActionNamesByInteraction<
  TPlugin extends SagaPluginManifest,
  TInteraction extends SagaPluginInteraction
> = {
  [TActionName in keyof TPlugin['actions'] & string]: TPlugin['actions'][TActionName]['interaction'] extends TInteraction
    ? TActionName
    : never;
}[keyof TPlugin['actions'] & string];

export type SagaPluginFireAndForgetActionNames<TPlugin extends SagaPluginManifest> =
  SagaPluginActionNamesByInteraction<TPlugin, 'fire_and_forget'>;

export type SagaPluginRequestResponseActionNames<TPlugin extends SagaPluginManifest> =
  SagaPluginActionNamesByInteraction<TPlugin, 'request_response'>;

export type SagaResponseHandlerPhase = 'response' | 'error' | 'retry';

declare const sagaResponseHandlerTokenBrand: unique symbol;

type SagaPhaseToken<TToken extends string, TPhase extends SagaResponseHandlerPhase> = TToken & {
  readonly [sagaResponseHandlerTokenBrand]: TPhase;
};

export type TResponseToken<TToken extends string = string> = SagaPhaseToken<TToken, 'response'>;

export type TErrorToken<TToken extends string = string> = SagaPhaseToken<TToken, 'error'>;

export type TRetryToken<TToken extends string = string> = SagaPhaseToken<TToken, 'retry'>;

export interface SagaResponseHandlerTokenBinding<
  TPhase extends SagaResponseHandlerPhase = SagaResponseHandlerPhase
> {
  readonly phase: TPhase;
}

export type SagaResponseHandlerTokenBindings = Record<string, SagaResponseHandlerTokenBinding>;

export type SagaResponseTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'response'>;

export type SagaErrorTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'error'>;

export type SagaRetryTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'retry'>;

type SagaResponseHandlerTokenForPhase<
  TToken extends string,
  TPhase extends SagaResponseHandlerPhase
> = TPhase extends 'response'
  ? TResponseToken<TToken>
  : TPhase extends 'error'
    ? TErrorToken<TToken>
    : TRetryToken<TToken>;

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
  readonly [THandlerKey in SagaResponseHandlerKeysByPhase<TBindings, TPhase>]: SagaResponseHandlerTokenForPhase<
    THandlerKey,
    TPhase
  >;
};

export type SagaResponseHandlerTokenAccess<TBindings extends SagaResponseHandlerTokenBindings> = {
  readonly onResponse: SagaResponseHandlerTokenNamespace<TBindings, 'response'>;
  readonly onError: SagaResponseHandlerTokenNamespace<TBindings, 'error'>;
  readonly onRetry: SagaResponseHandlerTokenNamespace<TBindings, 'retry'>;
};

type SagaBindingsFromResponseHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'response'>;
};

type SagaBindingsFromErrorHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'error'>;
};

type SagaBindingsFromRetryHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'retry'>;
};

type SagaAnyResponseHandlerMap<TState, TPlugins extends SagaPluginManifestList> = Record<
  string,
  SagaExecutableResponseHandler<TState, TPlugins, any, any>
>;

type SagaAnyErrorHandlerMap<TState, TPlugins extends SagaPluginManifestList> = Record<
  string,
  SagaExecutableErrorHandler<TState, TPlugins, any, any>
>;

type SagaAnyRetryHandlerMap<TState, TPlugins extends SagaPluginManifestList> = Record<
  string,
  SagaExecutableRetryHandler<TState, TPlugins, any, any>
>;

export interface SagaOneWayActionDefinition<TBuild extends AnyFunction = AnyFunction> {
  readonly build: TBuild;
  readonly description?: string;
}

export interface SagaRequestResponseActionDefinition<TBuild extends AnyFunction = AnyFunction> {
  readonly build: TBuild;
  readonly description?: string;
}

export interface SagaCustomActionPendingState<
  TExecutionPayload = unknown,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata = SagaPluginRequestRoutingMetadata
> {
  execution_payload: TExecutionPayload;
  routing_metadata?: TRoutingMetadata;
}

/**
 * Constrained primitive surface provided to `defineCustomAction(...)` builders.
 */
export interface SagaCustomActionBuilderCtx<
  TExecutionPayload = unknown,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata = SagaPluginRequestRoutingMetadata
> {
  createPending: (initial: SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata>) => void;
  patch: (patch: Partial<SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata>>) => void;
  set: (next: SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata>) => void;
  snapshot: () => Readonly<SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata>>;
  finalize: () => Readonly<SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata>>;
  emit: () => void;
  complete: () => void;
  isComplete: () => boolean;
}

export interface SagaCustomOneWayActionDefinition<
  TArgs extends unknown[] = unknown[],
  TExecutionPayload = unknown
> {
  readonly interaction: 'fire_and_forget';
  readonly build: (
    builderCtx: SagaCustomActionBuilderCtx<TExecutionPayload, SagaPluginRequestRoutingMetadata>,
    ...args: TArgs
  ) => TExecutionPayload;
  readonly description?: string;
}

export interface SagaCustomRequestResponseActionDefinition<
  TArgs extends unknown[] = unknown[],
  TExecutionPayload = unknown,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata = SagaPluginRequestRoutingMetadata
> {
  readonly interaction: 'request_response';
  readonly build: (
    builderCtx: SagaCustomActionBuilderCtx<TExecutionPayload, TRoutingMetadata>,
    ...args: TArgs
  ) => TExecutionPayload;
  readonly description?: string;
}

type SagaCustomActionDefinition =
  | SagaCustomOneWayActionDefinition<unknown[], unknown>
  | SagaCustomRequestResponseActionDefinition<unknown[], unknown, SagaPluginRequestRoutingMetadata>;

function normalizeActionDefinition<TBuild extends AnyFunction>(
  input: TBuild | { readonly build: TBuild; readonly description?: string }
): { build: TBuild; description?: string } {
  return typeof input === 'function'
    ? { build: input }
    : { build: input.build, ...(input.description === undefined ? {} : { description: input.description }) };
}

/** Additive helper for authoring one-way action descriptors. */
export function defineOneWay<TBuild extends AnyFunction>(
  input: TBuild | SagaOneWayActionDefinition<TBuild>
): SagaOneWayHelperActionDescriptor<TBuild> {
  const normalized = normalizeActionDefinition(input);
  return {
    interaction: 'fire_and_forget',
    build: normalized.build,
    [SAGA_HELPER_EMISSION_MODE]: 'fire_and_forget',
    ...(normalized.description === undefined ? {} : { description: normalized.description })
  };
}

/** Additive helper for authoring request-response action descriptors. */
export function defineRequestResponse<TBuild extends AnyFunction>(
  input: TBuild | SagaRequestResponseActionDefinition<TBuild>
): SagaRequestResponseHelperActionDescriptor<TBuild> {
  const normalized = normalizeActionDefinition(input);
  return {
    interaction: 'request_response',
    build: normalized.build,
    [SAGA_HELPER_EMISSION_MODE]: 'request_response',
    ...(normalized.description === undefined ? {} : { description: normalized.description })
  };
}

function createCustomActionBuilderCtx<
  TExecutionPayload,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata
>(): SagaCustomActionBuilderCtx<TExecutionPayload, TRoutingMetadata> {
  let pending: SagaCustomActionPendingState<TExecutionPayload, TRoutingMetadata> = {
    execution_payload: undefined as unknown as TExecutionPayload
  };
  let completed = false;

  const snapshot = () => ({ ...pending });

  return {
    createPending(initial) {
      pending = { ...initial };
    },
    patch(next) {
      pending = { ...pending, ...next };
    },
    set(next) {
      pending = { ...next };
    },
    snapshot,
    finalize: snapshot,
    emit() {
      completed = true;
    },
    complete() {
      completed = true;
    },
    isComplete() {
      return completed;
    }
  };
}

/**
 * Additive helper for custom action descriptors with constrained builderCtx
 * primitives. Returned descriptors remain backward-compatible raw descriptors.
 */
export function defineCustomAction<
  TArgs extends unknown[],
  TExecutionPayload
>(
  definition: SagaCustomOneWayActionDefinition<TArgs, TExecutionPayload>
): SagaPluginFireAndForgetActionDescriptor<(...args: TArgs) => TExecutionPayload>;
export function defineCustomAction<
  TArgs extends unknown[],
  TExecutionPayload,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata
>(
  definition: SagaCustomRequestResponseActionDefinition<TArgs, TExecutionPayload, TRoutingMetadata>
): SagaPluginRequestResponseActionDescriptor<(...args: TArgs) => TExecutionPayload>;
export function defineCustomAction(
  definition: SagaCustomActionDefinition
): SagaPluginActionDescriptor<AnyFunction> {
  const build = (...args: unknown[]) => {
    const builderCtx = createCustomActionBuilderCtx<unknown, SagaPluginRequestRoutingMetadata>();
    const output = definition.build(builderCtx, ...args);
    const snapshot = builderCtx.snapshot();
    return snapshot.execution_payload === undefined ? output : snapshot.execution_payload;
  };

  if (definition.interaction === 'fire_and_forget') {
    return defineOneWay({
      build,
      ...(definition.description === undefined ? {} : { description: definition.description })
    });
  }

  return defineRequestResponse({
    build,
    ...(definition.description === undefined ? {} : { description: definition.description })
  });
}

/** Minimal request envelope forwarded to external response/error handlers. */
export interface SagaExternalHandlerRequestContext {
  readonly plugin_key: string;
  readonly action_name: string;
  readonly sagaId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** Input shape for executable response callbacks. */
export interface SagaResponseCallbackEnvelope<TToken extends string = string, TPayload = unknown> {
  readonly token: TToken;
  readonly payload: TPayload;
  readonly request: SagaExternalHandlerRequestContext;
}

/** Input shape for executable error callbacks. */
export interface SagaErrorCallbackEnvelope<TToken extends string = string, TError = unknown> {
  readonly token: TToken;
  readonly error: TError;
  readonly request: SagaExternalHandlerRequestContext;
}

/** Input shape for executable retry callbacks. */
export interface SagaRetryCallbackEnvelope<TToken extends string = string, TPayload = unknown> {
  readonly token: TToken;
  readonly payload: TPayload;
  readonly request: SagaExternalHandlerRequestContext;
}

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

type SagaRequestActionChainWithDataStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings
> = {
  withData: <THandlerData>(
    data: THandlerData
  ) => SagaRequestActionChainOnResponseStep<TPluginKey, TActionName, TExecutionPayload, TBindings, THandlerData>;
  onResponse: <TResponseHandlerKey extends TResponseToken<SagaResponseTokenKey<TBindings>>>(
    token: TResponseHandlerKey
  ) => SagaRequestActionChainPostResponseStep<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    TBindings,
    undefined,
    TResponseHandlerKey
  >;
};

type SagaRequestActionChainOnResponseStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings,
  THandlerData
> = {
  onResponse: <TResponseHandlerKey extends TResponseToken<SagaResponseTokenKey<TBindings>>>(
    token: TResponseHandlerKey
  ) => SagaRequestActionChainPostResponseStep<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    TBindings,
    THandlerData,
    TResponseHandlerKey
  >;
};

type SagaRequestActionChainPostResponseStep<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings,
  THandlerData,
  TResponseHandlerKey extends TResponseToken<string>
> = {
  onRetry: <TRetryHandlerKey extends TRetryToken<SagaRetryTokenKey<TBindings>>>(
    token: TRetryHandlerKey
  ) => SagaRequestActionChainOnErrorStepWithRetry<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    TBindings,
    THandlerData,
    TResponseHandlerKey,
    TRetryHandlerKey
  >;
  onError: <TErrorHandlerKey extends TErrorToken<SagaErrorTokenKey<TBindings>>>(
    token: TErrorHandlerKey
  ) => SagaPluginIntent<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    'request_response',
    SagaPluginRequestRoutingMetadata<TResponseHandlerKey, TErrorHandlerKey, THandlerData>
  >;
};

type SagaRequestActionChainOnErrorStepWithRetry<
  TPluginKey extends string,
  TActionName extends string,
  TExecutionPayload,
  TBindings extends SagaResponseHandlerTokenBindings,
  THandlerData,
  TResponseHandlerKey extends TResponseToken<string>,
  TRetryHandlerKey extends TRetryToken<string>
> = {
  onError: <TErrorHandlerKey extends TErrorToken<SagaErrorTokenKey<TBindings>>>(
    token: TErrorHandlerKey
  ) => SagaPluginIntent<
    TPluginKey,
    TActionName,
    TExecutionPayload,
    'request_response',
    SagaPluginRequestRoutingMetadata<TResponseHandlerKey, TErrorHandlerKey, THandlerData, TRetryHandlerKey>
  >;
};

type SagaPluginActionContextForManifestAction<
  TPluginKey extends string,
  TActionName extends string,
  TAction extends SagaPluginActionDescriptor,
  TBindings extends SagaResponseHandlerTokenBindings
> = TAction['interaction'] extends 'request_response'
  ? (
      ...args: SagaPluginActionArguments<TAction>
    ) => SagaRequestActionChainWithDataStep<
      TPluginKey,
      TActionName,
      SagaPluginActionExecutionPayload<TAction>,
      TBindings
    >
  : TAction extends { readonly [SAGA_HELPER_EMISSION_MODE]: 'fire_and_forget' }
    ? (...args: SagaPluginActionArguments<TAction>) => SagaPluginIntent<
      TPluginKey,
      TActionName,
      SagaPluginActionExecutionPayload<TAction>,
      'fire_and_forget'
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

/** Routing metadata used by plugin request-response intents. */
export interface SagaPluginRequestRoutingMetadata<
  TResponseHandlerKey extends string = string,
  TErrorHandlerKey extends string = string,
  THandlerData = unknown,
  TRetryHandlerKey extends string = string
> {
  readonly response_handler_key: TResponseHandlerKey;
  readonly error_handler_key: TErrorHandlerKey;
  readonly handler_data: THandlerData;
  readonly retry_handler_key?: TRetryHandlerKey;
}

/**
 * Unified intent that requests plugin execution.
 */
export type SagaPluginIntent<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TExecutionPayload = unknown,
  TInteraction extends SagaPluginInteraction = SagaPluginInteraction,
  TRoutingMetadata extends SagaPluginRequestRoutingMetadata = SagaPluginRequestRoutingMetadata
> = {
  readonly type: 'plugin-intent';
  readonly plugin_key: TPluginKey;
  readonly action_name: TActionName;
  readonly interaction: TInteraction;
  readonly execution_payload: TExecutionPayload;
  readonly metadata: SagaIntentMetadata;
} & (
  TInteraction extends 'request_response'
    ? { readonly routing_metadata: TRoutingMetadata }
    : { readonly routing_metadata?: never }
);

/** Full intent union emitted by saga handlers. */
export type SagaIntent = SagaPluginIntent;

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
      ? (...args: TArgs) => SagaPluginIntent<
        'core',
        'dispatch',
        {
          readonly command: TCommandName;
          readonly payload: TPayload;
          readonly aggregateId: string;
        },
        'fire_and_forget'
      >
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
): SagaPluginIntent<
  'core',
  'dispatch',
  {
    readonly command: TCommandName;
    readonly payload: TPayload;
    readonly aggregateId: string;
  },
  'fire_and_forget'
> {
  return {
    type: 'plugin-intent',
    plugin_key: 'core',
    action_name: 'dispatch',
    interaction: 'fire_and_forget',
    execution_payload: {
      command,
      payload: envelope.payload,
      aggregateId: aggregateId ?? 'unknown-aggregate-id'
    },
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
) => SagaPluginIntent<'core', 'schedule', { readonly id: string; readonly delay: number }, 'fire_and_forget'>;

type SagaCoreCancelScheduleBuild = (
  id: string,
  metadata?: Partial<SagaIntentMetadata>
) => SagaPluginIntent<'core', 'cancelSchedule', { readonly id: string }, 'fire_and_forget'>;

export type SagaCorePluginManifest = SagaPluginManifest<
  'core',
  {
    readonly dispatch: SagaPluginFireAndForgetActionDescriptor;
    readonly dispatchTo: SagaPluginFireAndForgetActionDescriptor;
    readonly schedule: SagaPluginFireAndForgetActionDescriptor;
    readonly cancelSchedule: SagaPluginFireAndForgetActionDescriptor;
  }
>;

type SagaCoreActionsContext = {
  readonly dispatch: SagaDispatchTo;
  readonly dispatchTo: SagaDispatchTo;
  readonly schedule: SagaCoreScheduleBuild;
  readonly cancelSchedule: SagaCoreCancelScheduleBuild;
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
  schedule: (id: string, delay: number, metadata?: Partial<SagaIntentMetadata>) => SagaPluginIntent<'core', 'schedule', { readonly id: string; readonly delay: number }, 'fire_and_forget'>;
  cancelSchedule: (id: string, metadata?: Partial<SagaIntentMetadata>) => SagaPluginIntent<'core', 'cancelSchedule', { readonly id: string }, 'fire_and_forget'>;
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

  return defineSagaPlugin({
    plugin_key: 'core',
    actions: {
      dispatch: {
        interaction: 'fire_and_forget',
        build: dispatchBuild,
        description: 'Aggregate command dispatch helper'
      },
      dispatchTo: {
        interaction: 'fire_and_forget',
        build: dispatchBuild,
        description: 'Alias for aggregate command dispatch helper'
      },
      schedule: {
        interaction: 'fire_and_forget',
        build: (id, delay, metadataOverride) => {
          const intent: SagaPluginIntent<'core', 'schedule', { readonly id: string; readonly delay: number }, 'fire_and_forget'> = {
            type: 'plugin-intent',
            plugin_key: 'core',
            action_name: 'schedule',
            interaction: 'fire_and_forget',
            execution_payload: { id, delay },
            metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
          };

          emitIntent(intent);
          return intent;
        },
        description: 'Schedule delayed saga wake-up'
      },
      cancelSchedule: {
        interaction: 'fire_and_forget',
        build: (id, metadataOverride) => {
          const intent: SagaPluginIntent<'core', 'cancelSchedule', { readonly id: string }, 'fire_and_forget'> = {
            type: 'plugin-intent',
            plugin_key: 'core',
            action_name: 'cancelSchedule',
            interaction: 'fire_and_forget',
            execution_payload: { id },
            metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
          };

          emitIntent(intent);
          return intent;
        },
        description: 'Cancel delayed saga wake-up'
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
      const actionDescriptor = plugin.actions[actionName] as SagaPluginActionDescriptorWithHelperMetadata;

      if (actionDescriptor.interaction === 'request_response') {
        pluginActions[actionName] = (...args: any[]) => {
          const executionPayload = actionDescriptor.build(...args);
          let terminalIntent: SagaPluginIntent<string, string, unknown, 'request_response'> | undefined;

          const createIntent = (
            handlerData: unknown,
            responseHandlerKey: string,
            errorHandlerKey: string,
            retryHandlerKey?: string
          ) => {
            if (terminalIntent !== undefined) {
              return terminalIntent;
            }

            const intent: SagaPluginIntent<string, string, unknown, 'request_response'> = {
              type: 'plugin-intent',
              plugin_key: plugin.plugin_key,
              action_name: actionName,
              interaction: 'request_response',
              execution_payload: executionPayload,
              routing_metadata: {
                response_handler_key: responseHandlerKey,
                error_handler_key: errorHandlerKey,
                handler_data: handlerData,
                ...(retryHandlerKey === undefined ? {} : { retry_handler_key: retryHandlerKey })
              },
              metadata
            };

            emitIntent(intent);
            terminalIntent = intent;
            return intent;
          };

          const createResponseChain = (handlerData: unknown) => ({
            onResponse: (responseHandlerKey: string) => ({
              onRetry: (retryHandlerKey: string) => ({
                onError: (errorHandlerKey: string) => createIntent(
                  handlerData,
                  responseHandlerKey,
                  errorHandlerKey,
                  retryHandlerKey
                )
              }),
              onError: (errorHandlerKey: string) => createIntent(handlerData, responseHandlerKey, errorHandlerKey)
            })
          });

          return {
            withData: (handlerData: unknown) => createResponseChain(handlerData),
            onResponse: createResponseChain(undefined).onResponse
          };
        };
        continue;
      }

      pluginActions[actionName] = (...args: any[]) => {
        const executionPayload = actionDescriptor.build(...args);

        if (actionDescriptor[SAGA_HELPER_EMISSION_MODE] !== 'fire_and_forget') {
          return executionPayload;
        }

        const intent: SagaPluginIntent<string, string, unknown, 'fire_and_forget'> = {
          type: 'plugin-intent',
          plugin_key: plugin.plugin_key,
          action_name: actionName,
          interaction: 'fire_and_forget',
          execution_payload: executionPayload,
          metadata
        };

        emitIntent(intent);
        return intent;
      };
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
  const onRetry = createResponseHandlerTokenNamespace(responseHandlers, 'retry');
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
    onRetry,
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

export type SagaExecutableResponseHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>> =
    TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>>
> = (
  state: Draft<TState>,
  response: SagaResponseCallbackEnvelope<TToken>,
  ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
) => SagaHandlerResult;

export type SagaExecutableErrorHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>> =
    TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>>
> = (
  state: Draft<TState>,
  error: SagaErrorCallbackEnvelope<TToken>,
  ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
) => SagaHandlerResult;

export type SagaExecutableResponseHandlers<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = {
  /**
   * Runtime-only executable response handlers keyed by response token.
   *
   * This map is intentionally non-serialized and not part of the
   * persisted/wire `response_handlers` contract.
   */
  [TToken in SagaResponseTokenKey<TResponseHandlerBindings>]?: SagaExecutableResponseHandler<
    TState,
    TPlugins,
    TResponseHandlerBindings,
    TResponseToken<TToken>
  >;
};

export type SagaExecutableErrorHandlers<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = {
  /**
   * Runtime-only executable error handlers keyed by error token.
   *
   * This map is intentionally non-serialized and not part of the
   * persisted/wire `response_handlers` contract.
   */
  [TToken in SagaErrorTokenKey<TResponseHandlerBindings>]?: SagaExecutableErrorHandler<
    TState,
    TPlugins,
    TResponseHandlerBindings,
    TErrorToken<TToken>
  >;
};

export type SagaExecutableRetryHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TRetryToken<SagaRetryTokenKey<TResponseHandlerBindings>> =
    TRetryToken<SagaRetryTokenKey<TResponseHandlerBindings>>
> = (
  state: Draft<TState>,
  retry: SagaRetryCallbackEnvelope<TToken>,
  ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
) => SagaHandlerResult;

export type SagaExecutableRetryHandlers<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> = {
  /** Runtime-only executable retry handlers keyed by retry token. */
  [TToken in SagaRetryTokenKey<TResponseHandlerBindings>]?: SagaExecutableRetryHandler<
    TState,
    TPlugins,
    TResponseHandlerBindings,
    TRetryToken<TToken>
  >;
};

export type SagaExecutableHandlerFailureReason =
  | 'token_not_defined'
  | 'handler_not_registered';

export type SagaExecutableHandlerSuccessResult<TState, TToken extends string = string> = {
  readonly ok: true;
  readonly output: SagaReducerOutput<TState>;
  readonly token: TToken;
};

export type SagaExecutableHandlerFailureResult<TToken extends string = string> = {
  readonly ok: false;
  readonly reason: SagaExecutableHandlerFailureReason;
  readonly token: TToken;
};

export type SagaExecutableHandlerResult<TState, TToken extends string = string> =
  | SagaExecutableHandlerSuccessResult<TState, TToken>
  | SagaExecutableHandlerFailureResult<TToken>;

export interface RunSagaResponseHandlerInput<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>> =
    TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>>,
  TPayload = unknown
> {
  readonly definition: SagaDefinition<TState, TPlugins, TResponseHandlerBindings>;
  readonly state: TState;
  readonly envelope: SagaResponseCallbackEnvelope<TToken, TPayload>;
  readonly intentMetadata?: Partial<SagaIntentMetadata>;
  readonly plugins?: TPlugins;
}

export interface RunSagaErrorHandlerInput<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>> =
    TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>>,
  TError = unknown
> {
  readonly definition: SagaDefinition<TState, TPlugins, TResponseHandlerBindings>;
  readonly state: TState;
  readonly envelope: SagaErrorCallbackEnvelope<TToken, TError>;
  readonly intentMetadata?: Partial<SagaIntentMetadata>;
  readonly plugins?: TPlugins;
}

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
  sagaKey: string;
  sagaType: string;
  sagaUrn: string;
  plugins: SagaPluginRegistryFromManifests<TPlugins>;
  initialState: SagaInitialStateFactory<TState>;
  start?: SagaStartHandler<unknown, TState, TPlugins, TResponseHandlerBindings>;
  startContracts: SagaStartDslContracts<unknown, unknown>;
  responseHandlers: SagaExecutableResponseHandlers<TState, TPlugins, TResponseHandlerBindings>;
  errorHandlers: SagaExecutableErrorHandlers<TState, TPlugins, TResponseHandlerBindings>;
  retryHandlers: SagaExecutableRetryHandlers<TState, TPlugins, TResponseHandlerBindings>;
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
  onResponses<THandlers extends SagaAnyResponseHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilder<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>>;
  onErrors<THandlers extends SagaAnyErrorHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilder<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>>;
  onRetries<THandlers extends SagaAnyRetryHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilder<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>>;
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
  onResponses<THandlers extends SagaAnyResponseHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>, TStartInput>;
  onErrors<THandlers extends SagaAnyErrorHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>, TStartInput>;
  onRetries<THandlers extends SagaAnyRetryHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderAwaitingCorrelation<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>, TStartInput>;
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
  onResponses<THandlers extends SagaAnyResponseHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>, TStartInput, TCorrelationId>;
  onErrors<THandlers extends SagaAnyErrorHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>, TStartInput, TCorrelationId>;
  onRetries<THandlers extends SagaAnyRetryHandlerMap<TState, TPlugins>>(
    handlers: THandlers
  ): SagaBuilderCorrelated<TState, TPlugins, TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>, TStartInput, TCorrelationId>;
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
  identity: SagaIdentityInput;
  plugins?: TPlugins;
}

export interface SagaIdentityFields {
  namespace: string;
  name: string;
  version: number;
}

export interface SagaIdentityMetadata extends SagaIdentityFields {
  sagaKey: string;
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
  sagaKey: string;
  sagaType: string;
  sagaUrn: string;
  plugins: TPlugins;
  initialState: SagaInitialStateFactory<unknown>;
  start?: SagaStartHandler<unknown, unknown, SagaPluginManifestList, SagaResponseHandlerTokenBindings>;
  startContracts: SagaStartDslContracts<unknown, unknown>;
  responseHandlers: SagaExecutableResponseHandlers<
    unknown,
    SagaPluginManifestList,
    TResponseHandlerBindings
  >;
  errorHandlers: SagaExecutableErrorHandlers<
    unknown,
    SagaPluginManifestList,
    TResponseHandlerBindings
  >;
  retryHandlers: SagaExecutableRetryHandlers<
    unknown,
    SagaPluginManifestList,
    TResponseHandlerBindings
  >;
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

function resolveSagaIdentity(options: CreateSagaOptions<SagaPluginManifestList>): SagaIdentityMetadata {
  const normalized = normalizeSagaIdentity(options.identity);
  return {
    namespace: normalized.namespace,
    name: normalized.name,
    version: normalized.version,
    sagaKey: normalized.sagaKey,
    sagaType: normalized.sagaType,
    sagaUrn: normalized.sagaUrn
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

function resolveIntentMetadata(
  request: SagaExternalHandlerRequestContext,
  override?: Partial<SagaIntentMetadata>
): SagaIntentMetadata {
  return {
    sagaId: override?.sagaId ?? request.sagaId ?? 'unknown-saga-id',
    correlationId: override?.correlationId ?? request.correlationId ?? 'unknown-correlation-id',
    causationId: override?.causationId ?? request.causationId ?? 'unknown-causation-id'
  };
}

function createTokenBindingsFromHandlerMaps<
  TResponseHandlers extends Record<string, unknown>,
  TErrorHandlers extends Record<string, unknown>,
  TRetryHandlers extends Record<string, unknown>
>(
  responseHandlers: TResponseHandlers,
  errorHandlers: TErrorHandlers,
  retryHandlers: TRetryHandlers
): SagaBindingsFromResponseHandlers<TResponseHandlers>
  & SagaBindingsFromErrorHandlers<TErrorHandlers>
  & SagaBindingsFromRetryHandlers<TRetryHandlers> {
  const bindings: Record<string, SagaResponseHandlerTokenBinding> = {};

  for (const token of Object.keys(responseHandlers)) {
    bindings[token] = { phase: 'response' };
  }

  for (const token of Object.keys(errorHandlers)) {
    bindings[token] = { phase: 'error' };
  }

  for (const token of Object.keys(retryHandlers)) {
    bindings[token] = { phase: 'retry' };
  }

  return bindings as SagaBindingsFromResponseHandlers<TResponseHandlers>
    & SagaBindingsFromErrorHandlers<TErrorHandlers>
    & SagaBindingsFromRetryHandlers<TRetryHandlers>;
}

function hasOwnToken(handlers: Record<string, unknown> | undefined, token: string): boolean {
  if (handlers === undefined) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(handlers, token);
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

export async function runSagaResponseHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>> =
    TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>>,
  TPayload = unknown
>(
  input: RunSagaResponseHandlerInput<TState, TPlugins, TResponseHandlerBindings, TToken, TPayload>
): Promise<SagaExecutableHandlerResult<TState, TToken>> {
  const {
    definition,
    state,
    envelope,
    intentMetadata,
    plugins = [] as unknown as TPlugins
  } = input;
  const token = envelope.token;
  if (!hasOwnToken(definition.responseHandlers as Record<string, unknown>, token)) {
    return {
      ok: false,
      reason: 'token_not_defined',
      token
    };
  }

  const handler = (definition.responseHandlers as Record<
    string,
    SagaExecutableResponseHandler<TState, TPlugins, TResponseHandlerBindings, any> | undefined
  >)[token];

  if (handler === undefined) {
    return {
      ok: false,
      reason: 'handler_not_registered',
      token
    };
  }

  const draft = createDraft(state);
  const intents: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TResponseHandlerBindings>(
    resolveIntentMetadata(envelope.request, intentMetadata),
    intents,
    createTokenBindingsFromHandlerMaps(
      definition.responseHandlers,
      definition.errorHandlers,
      definition.retryHandlers
    ) as TResponseHandlerBindings,
    plugins
  );

  await handler(draft, envelope as SagaResponseCallbackEnvelope<any, TPayload>, ctx);

  return {
    ok: true,
    output: {
      state: finishDraft(draft) as TState,
      intents
    },
    token
  };
}

export async function runSagaErrorHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>> =
    TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>>,
  TError = unknown
>(
  input: RunSagaErrorHandlerInput<TState, TPlugins, TResponseHandlerBindings, TToken, TError>
): Promise<SagaExecutableHandlerResult<TState, TToken>> {
  const {
    definition,
    state,
    envelope,
    intentMetadata,
    plugins = [] as unknown as TPlugins
  } = input;
  const token = envelope.token;
  if (!hasOwnToken(definition.errorHandlers as Record<string, unknown>, token)) {
    return {
      ok: false,
      reason: 'token_not_defined',
      token
    };
  }

  const handler = (definition.errorHandlers as Record<
    string,
    SagaExecutableErrorHandler<TState, TPlugins, TResponseHandlerBindings, any> | undefined
  >)[token];

  if (handler === undefined) {
    return {
      ok: false,
      reason: 'handler_not_registered',
      token
    };
  }

  const draft = createDraft(state);
  const intents: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TResponseHandlerBindings>(
    resolveIntentMetadata(envelope.request, intentMetadata),
    intents,
    createTokenBindingsFromHandlerMaps(
      definition.responseHandlers,
      definition.errorHandlers,
      definition.retryHandlers
    ) as TResponseHandlerBindings,
    plugins
  );

  await handler(draft, envelope as SagaErrorCallbackEnvelope<any, TError>, ctx);

  return {
    ok: true,
    output: {
      state: finishDraft(draft) as TState,
      intents
    },
    token
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
    onResponses<THandlers extends SagaAnyResponseHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;
      nextState.responseHandlers = {
        ...(state.responseHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableResponseHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;

      return createAwaitingCorrelationBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>,
        TStartInput
      >();
    },
    onErrors<THandlers extends SagaAnyErrorHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;
      nextState.errorHandlers = {
        ...(state.errorHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableErrorHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;

      return createAwaitingCorrelationBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>,
        TStartInput
      >();
    },
    onRetries<THandlers extends SagaAnyRetryHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;
      nextState.retryHandlers = {
        ...(state.retryHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableRetryHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;

      return createAwaitingCorrelationBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>,
        TStartInput
      >();
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
    onResponses<THandlers extends SagaAnyResponseHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;
      nextState.responseHandlers = {
        ...(state.responseHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableResponseHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;

      return createCorrelatedBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>,
        TStartInput,
        TCorrelationId
      >();
    },
    onErrors<THandlers extends SagaAnyErrorHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;
      nextState.errorHandlers = {
        ...(state.errorHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableErrorHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;

      return createCorrelatedBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>,
        TStartInput,
        TCorrelationId
      >();
    },
    onRetries<THandlers extends SagaAnyRetryHandlerMap<TLocalState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;
      nextState.retryHandlers = {
        ...(state.retryHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableRetryHandlers<
        unknown,
        SagaPluginManifestList,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;

      return createCorrelatedBuilder<
        TLocalState,
        TLocalResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>,
        TStartInput,
        TCorrelationId
      >();
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
        responseHandlers: { ...state.responseHandlers },
        errorHandlers: { ...state.errorHandlers },
        retryHandlers: { ...state.retryHandlers }
      } as unknown) as SagaDefinition<TLocalState, TPlugins, TLocalResponseHandlerBindings>;
    }
  });

  return {
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createSagaBuilder<TNextState, TPlugins, TResponseHandlerBindings>(state);
    },
    onResponses<THandlers extends SagaAnyResponseHandlerMap<TState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;
      nextState.responseHandlers = {
        ...(state.responseHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableResponseHandlers<
        unknown,
        SagaPluginManifestList,
        TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >;
      return createSagaBuilder<
        TState,
        TPlugins,
        TResponseHandlerBindings & SagaBindingsFromResponseHandlers<THandlers>
      >(nextState);
    },
    onErrors<THandlers extends SagaAnyErrorHandlerMap<TState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;
      nextState.errorHandlers = {
        ...(state.errorHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableErrorHandlers<
        unknown,
        SagaPluginManifestList,
        TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >;
      return createSagaBuilder<
        TState,
        TPlugins,
        TResponseHandlerBindings & SagaBindingsFromErrorHandlers<THandlers>
      >(nextState);
    },
    onRetries<THandlers extends SagaAnyRetryHandlerMap<TState, TPlugins>>(handlers: THandlers) {
      const nextState = state as unknown as SagaDefinitionDraft<
        SagaPluginRegistryFromManifests<TPlugins>,
        TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;
      nextState.retryHandlers = {
        ...(state.retryHandlers as Record<string, unknown>),
        ...handlers
      } as SagaExecutableRetryHandlers<
        unknown,
        SagaPluginManifestList,
        TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >;
      return createSagaBuilder<
        TState,
        TPlugins,
        TResponseHandlerBindings & SagaBindingsFromRetryHandlers<THandlers>
      >(nextState);
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
        responseHandlers: { ...state.responseHandlers },
        errorHandlers: { ...state.errorHandlers },
        retryHandlers: { ...state.retryHandlers }
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
    name: identity.name,
    identity,
    sagaKey: identity.sagaKey,
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
    responseHandlers: {},
    errorHandlers: {},
    retryHandlers: {},
    correlations: [],
    handlers: []
  };

  return createSagaBuilder<TState, SagaPluginsFromOptions<TOptions>, Record<never, never>>(state);
}
