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

/** Typed helper bag that can be merged into saga handler context. */
export type SagaPluginContextExtensions = Record<string, unknown>;

/** Intent that delegates work to an activity function. */
export interface SagaRunActivityIntent<TResult = unknown> {
  readonly type: 'run-activity';
  readonly name: string;
  readonly closure: SagaActivityClosure<TResult>;
  readonly retryPolicy?: SagaRetryPolicy;
  readonly metadata: SagaIntentMetadata;
}

/** Full intent union emitted by saga handlers. */
export type SagaIntent =
  | SagaDispatchIntentForCommand<string, unknown>
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent;

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
 * Full context exposed to saga handlers, including optional plugin helpers.
 *
 * Plugin helpers are purely type-level and do not alter base runtime helpers.
 */
export type SagaIntentContext<
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
> = SagaIntentContextBase & TContextExtensions;

/**
 * Builds runtime saga intent helper implementations for handler execution.
 */
export function createSagaDispatchContext(
  metadata: SagaIntentMetadata,
  intents: SagaIntent[] = []
): SagaIntentContextBase {
  const emit = (intent: SagaIntent) => {
    intents.push(intent);
  };

  return {
    metadata,
    get intents() {
      return intents;
    },
    emit,
    commandsFor: (aggregateDef, aggregateId, metadataOverride) => createSagaCommandsFor(
      aggregateDef,
      aggregateId,
      metadata,
      emit,
      metadataOverride
    ),
    dispatchTo: (aggregateDef, aggregateId, metadataOverride) => createSagaCommandsFor(
      aggregateDef,
      aggregateId,
      metadata,
      emit,
      metadataOverride
    ),
    schedule: (id, delay, metadataOverride) => {
      const intent: SagaScheduleIntent = {
        type: 'schedule',
        id,
        delay,
        metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
      };

      emit(intent);
      return intent;
    },
    cancelSchedule: (id, metadataOverride) => {
      const intent: SagaCancelScheduleIntent = {
        type: 'cancel-schedule',
        id,
        metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
      };

      emit(intent);
      return intent;
    },
    runActivity: <TResult = unknown>(name: string, closure: SagaActivityClosure<TResult>, retryPolicy?: SagaRetryPolicy, metadataOverride?: Partial<SagaIntentMetadata>) => {
      const intent: SagaRunActivityIntent<TResult> = {
        type: 'run-activity',
        name,
        closure,
        retryPolicy,
        metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
      };

      emit(intent);
      return intent;
    }
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
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
> = (
  state: Draft<TState>,
  event: SagaAggregateEventByName<TAggregate, TEventName>,
  ctx: SagaIntentContext<TContextExtensions>
) => SagaHandlerResult;

/** Map of handler names to saga reducer functions. */
export type SagaHandlers<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
> = {
  [TEventName in SagaAggregateEventName<TAggregate>]?: SagaHandler<TState, TAggregate, TEventName, TContextExtensions>;
};

/** Built saga definition consumed by runtime execution layers. */
export interface SagaDefinition<
  TState = unknown,
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
> {
  name: string;
  initialState: SagaInitialStateFactory<TState>;
  correlations: Array<{
    aggregateType: string;
    aggregate: SagaAggregateDefinition;
    correlate: SagaCorrelationFactory;
  }>;
  handlers: Array<{
    aggregateType: string;
    aggregate: SagaAggregateDefinition;
    handlers: Record<string, SagaHandler<TState, SagaAggregateDefinition, string, TContextExtensions>>;
  }>;
}

/** Fluent builder for composing a saga definition. */
export interface SagaBuilder<
  TState = unknown,
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
> {
  initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>): SagaBuilder<TNextState, TContextExtensions>;
  correlate<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, correlate: SagaCorrelationFactory): SagaBuilder<TState, TContextExtensions>;
  on<TAggregate extends SagaAggregateDefinition>(aggregate: TAggregate, handlers: SagaHandlers<TState, TAggregate, TContextExtensions>): SagaBuilder<TState, TContextExtensions>;
  build(): SagaDefinition<TState, TContextExtensions>;
}

export interface CreateSagaOptions {
  name: string;
}

interface SagaDefinitionDraft {
  name: string;
  initialState: SagaInitialStateFactory<unknown>;
  correlations: Array<{
    aggregateType: string;
    aggregate: SagaAggregateDefinition;
    correlate: SagaCorrelationFactory;
  }>;
  handlers: Array<{
    aggregateType: string;
    aggregate: SagaAggregateDefinition;
    handlers: Record<string, SagaHandler<unknown, SagaAggregateDefinition, string>>;
  }>;
}

function getAggregateType(aggregate: SagaAggregateDefinition): string {
  return aggregate.__aggregateType ?? 'unknown';
}

/**
 * Executes a single saga handler with mutation-first semantics and produces
 * deterministic reducer output.
 */
export async function runSagaHandler<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TEventName extends SagaAggregateEventName<TAggregate>
>(
  state: TState,
  event: SagaAggregateEventByName<TAggregate, TEventName>,
  handler: SagaHandler<TState, TAggregate, TEventName>,
  metadata: SagaIntentMetadata
): Promise<SagaReducerOutput<TState>> {
  const draft = createDraft(state);
  const intentBuffer: SagaIntent[] = [];
  const ctx = createSagaDispatchContext(metadata, intentBuffer);

  await handler(draft, event, ctx);

  return {
    state: finishDraft(draft) as TState,
    intents: intentBuffer
  };
}

function createSagaBuilder<
  TState,
  TContextExtensions extends SagaPluginContextExtensions
>(state: SagaDefinitionDraft): SagaBuilder<TState, TContextExtensions> {
  return {
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createSagaBuilder<TNextState, TContextExtensions>(state);
    },
    correlate(aggregate, correlate) {
      state.correlations.push({
        aggregate,
        aggregateType: getAggregateType(aggregate),
        correlate
      });
      return createSagaBuilder<TState, TContextExtensions>(state);
    },
    on(aggregate, handlers) {
      state.handlers.push({
        aggregate,
        aggregateType: getAggregateType(aggregate),
        handlers: handlers as Record<string, SagaHandler<unknown, SagaAggregateDefinition, string>>
      });
      return createSagaBuilder<TState, TContextExtensions>(state);
    },
    build() {
      return state as SagaDefinition<TState, TContextExtensions>;
    }
  };
}

/**
 * Creates a fluent saga builder with aggregate-driven typing and mutable
 * handler draft semantics.
 */
export function createSaga<
  TState = unknown,
  TContextExtensions extends SagaPluginContextExtensions = Record<never, never>
>(nameOrOptions?: string | CreateSagaOptions): SagaBuilder<TState, TContextExtensions> {
  const name = typeof nameOrOptions === 'string'
    ? nameOrOptions
    : nameOrOptions?.name ?? 'unnamed-saga';

  const state: SagaDefinitionDraft = {
    name,
    initialState: () => undefined,
    correlations: [],
    handlers: []
  };

  return createSagaBuilder<TState, TContextExtensions>(state);
}
