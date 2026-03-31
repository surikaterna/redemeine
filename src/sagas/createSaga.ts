import type { SagaRetryPolicy } from './RetryPolicy';

/** Factory used to initialize saga state for a new saga definition. */
export type SagaInitialStateFactory<TState> = () => TState;

/**
 * Correlation resolver for routing domain events into saga instances.
 *
 * The function signature is intentionally open because event envelope shapes
 * vary between applications.
 */
export type SagaCorrelationFactory = (...args: unknown[]) => unknown;

/** Map of command names to their expected payload types. */
export type SagaCommandMap = Record<string, unknown>;

/** Command key constrained to string keys from a saga command map. */
export type SagaCommandName<TCommandMap extends SagaCommandMap> = keyof TCommandMap & string;

/** Payload type for a specific command key in a saga command map. */
export type SagaCommandPayload<
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
> = TCommandMap[TCommandName];

/** Required metadata attached to every emitted saga intent. */
export interface SagaIntentMetadata {
  sagaId: string;
  correlationId: string;
  causationId: string;
}

/** Typed dispatch intent for a single command entry. */
export type SagaDispatchIntentForCommand<
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
> = {
  readonly type: 'dispatch';
  readonly command: TCommandName;
  readonly payload: SagaCommandPayload<TCommandMap, TCommandName>;
  readonly aggregateId?: string;
  readonly metadata: SagaIntentMetadata;
};

/** Command envelope shape emitted by aggregate command creators. */
export interface SagaAggregateCommandEnvelope {
  readonly type: string;
  readonly payload: unknown;
}

/** Aggregate-like input accepted by `ctx.commandsFor(...)`. */
export type SagaCommandCreators = Record<string, (...args: any[]) => SagaAggregateCommandEnvelope>;

/** Aggregate-like input accepted by `ctx.commandsFor(...)`. */
export interface SagaAggregateWithCommandCreators<TCommandCreators extends SagaCommandCreators = SagaCommandCreators> {
  readonly commandCreators: TCommandCreators;
}

type SagaCommandIntentFactoryFromCreator<
  TCreator,
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
> = TCreator extends (...args: infer TArgs) => infer TEnvelope
  ? TEnvelope extends { payload: infer TPayload }
    ? TPayload extends SagaCommandPayload<TCommandMap, TCommandName>
      ? (
          ...args: TArgs
        ) => SagaDispatchIntentForCommand<TCommandMap, TCommandName> & { readonly aggregateId: string }
      : never
    : never
  : never;

/** Typed command-intent creators derived from aggregate command creators. */
export type SagaCommandsFor<
  TCommandCreators extends SagaCommandCreators,
  TCommandMap extends SagaCommandMap
> = {
  [TCommandName in Extract<keyof TCommandCreators, SagaCommandName<TCommandMap>>]: SagaCommandIntentFactoryFromCreator<
    TCommandCreators[TCommandName],
    TCommandMap,
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

function createSagaDispatchIntentFromEnvelope<
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
>(
  command: TCommandName,
  envelope: { payload: SagaCommandPayload<TCommandMap, TCommandName> },
  metadata: SagaIntentMetadata,
  metadataOverride?: Partial<SagaIntentMetadata>,
  aggregateId?: string
): SagaDispatchIntentForCommand<TCommandMap, TCommandName> {
  return {
    type: 'dispatch',
    command,
    payload: envelope.payload,
    aggregateId,
    metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
  };
}

/**
 * Creates typed aggregate-driven command intent emitters for saga reducers.
 *
 * Returned methods wrap aggregate command creators and emit dispatch intents
 * without executing commands immediately.
 */
export function createSagaCommandsFor<
  TCommandCreators extends SagaCommandCreators,
  TCommandMap extends SagaCommandMap
>(
  aggregateDef: SagaAggregateWithCommandCreators<TCommandCreators>,
  aggregateId: string,
  metadata: SagaIntentMetadata,
  metadataOverride?: Partial<SagaIntentMetadata>
): SagaCommandsFor<TCommandCreators, TCommandMap> {
  const commandIntents = {} as SagaCommandsFor<TCommandCreators, TCommandMap>;

  for (const commandName of Object.keys(aggregateDef.commandCreators)) {
    const createCommand = aggregateDef.commandCreators[commandName];

    (commandIntents as Record<string, (...args: any[]) => unknown>)[commandName] = (...args: any[]) => {
      const command = createCommand(...args);

      return createSagaDispatchIntentFromEnvelope(
        commandName as Extract<keyof TCommandCreators, SagaCommandName<TCommandMap>>,
        command as { payload: SagaCommandPayload<TCommandMap, Extract<keyof TCommandCreators, SagaCommandName<TCommandMap>>> },
        metadata,
        metadataOverride,
        aggregateId
      );
    };
  }

  return commandIntents;
}

/** Union of all typed dispatch intents for the command map. */
export type SagaDispatchIntent<TCommandMap extends SagaCommandMap> = {
  [TCommandName in SagaCommandName<TCommandMap>]: SagaDispatchIntentForCommand<TCommandMap, TCommandName>;
}[SagaCommandName<TCommandMap>];

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

/** Intent that delegates work to an activity function. */
export interface SagaRunActivityIntent<TResult = unknown> {
  readonly type: 'run-activity';
  readonly name: string;
  readonly closure: SagaActivityClosure<TResult>;
  readonly retryPolicy?: SagaRetryPolicy;
  readonly metadata: SagaIntentMetadata;
}

/** Full intent union emitted by saga handlers. */
export type SagaIntent<TCommandMap extends SagaCommandMap> =
  | SagaDispatchIntent<TCommandMap>
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent;

/**
 * Typed helper used by saga handlers to create dispatch intents.
 *
 * Metadata is optional at call-site and can be merged by runtime adapters.
 */
export type SagaDispatch<TCommandMap extends SagaCommandMap> = <
  TCommandName extends SagaCommandName<TCommandMap>
>(
  command: TCommandName,
  payload: SagaCommandPayload<TCommandMap, TCommandName>,
  metadata?: Partial<SagaIntentMetadata>
) => SagaDispatchIntentForCommand<TCommandMap, TCommandName>;

/** Function signature used for `run-activity` intent closures. */
export type SagaActivityClosure<TResult = unknown> = () => TResult | Promise<TResult>;

/** Typed helper used by saga handlers to create activity intents. */
export type SagaRunActivity = <TResult = unknown>(
  name: string,
  closure: SagaActivityClosure<TResult>,
  retryPolicy?: SagaRetryPolicy,
  metadata?: Partial<SagaIntentMetadata>
) => SagaRunActivityIntent<TResult>;

/** Handler context exposed to saga reducers. */
export interface SagaDispatchContext<TState, TCommandMap extends SagaCommandMap> {
  readonly state: TState;
  readonly metadata: SagaIntentMetadata;
  dispatch: SagaDispatch<TCommandMap>;
  commandsFor: <TCommandCreators extends SagaCommandCreators>(
    aggregateDef: SagaAggregateWithCommandCreators<TCommandCreators>,
    aggregateId: string,
    metadata?: Partial<SagaIntentMetadata>
  ) => SagaCommandsFor<TCommandCreators, TCommandMap>;
  schedule: (id: string, delay: number, metadata?: Partial<SagaIntentMetadata>) => SagaScheduleIntent;
  cancelSchedule: (id: string, metadata?: Partial<SagaIntentMetadata>) => SagaCancelScheduleIntent;
  runActivity: SagaRunActivity;
}

/**
 * Builds runtime saga intent helper implementations for reducer execution.
 *
 * First-class public helpers (`dispatch`, `schedule`, `cancelSchedule`,
 * `runActivity`) share the same metadata merge semantics as `commandsFor`.
 */
export function createSagaDispatchContext<TState, TCommandMap extends SagaCommandMap>(
  state: TState,
  metadata: SagaIntentMetadata
): SagaDispatchContext<TState, TCommandMap> {
  return {
    state,
    metadata,
    dispatch: (command, payload, metadataOverride) => createSagaDispatchIntentFromEnvelope(
      command,
      {
        payload
      },
      metadata,
      metadataOverride
    ),
    commandsFor: (aggregateDef, aggregateId, metadataOverride) => createSagaCommandsFor(
      aggregateDef,
      aggregateId,
      metadata,
      metadataOverride
    ),
    schedule: (id, delay, metadataOverride) => ({
      type: 'schedule',
      id,
      delay,
      metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
    }),
    cancelSchedule: (id, metadataOverride) => ({
      type: 'cancel-schedule',
      id,
      metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
    }),
    runActivity: (name, closure, retryPolicy, metadataOverride) => ({
      type: 'run-activity',
      name,
      closure,
      retryPolicy,
      metadata: mergeSagaIntentMetadata(metadata, metadataOverride)
    })
  };
}

/** Deterministic state transition emitted by saga handlers. */
export interface SagaStateTransition<TState> {
  readonly state: TState;
}

/**
 * Saga reducer contract.
 *
 * Every handler must return next state plus explicit side-effect intents.
 */
export interface SagaReducerOutput<TState, TCommandMap extends SagaCommandMap> extends SagaStateTransition<TState> {
  readonly intents: readonly SagaIntent<TCommandMap>[];
}

/** Sync or async saga handler result. */
export type SagaHandlerResult<TState, TCommandMap extends SagaCommandMap> =
  | SagaReducerOutput<TState, TCommandMap>
  | Promise<SagaReducerOutput<TState, TCommandMap>>;

/** Saga handler keyed under `.on(<aggregate>, handlers)` entries. */
export type SagaHandler<TState, TCommandMap extends SagaCommandMap> = (
  ctx: SagaDispatchContext<TState, TCommandMap>,
  ...args: unknown[]
) => SagaHandlerResult<TState, TCommandMap>;

/** Map of handler names to saga reducer functions. */
export type SagaHandlers<TState, TCommandMap extends SagaCommandMap> = Record<
  string,
  SagaHandler<TState, TCommandMap>
>;

/** Built saga definition consumed by runtime execution layers. */
export interface SagaDefinition<TState = unknown, TCommandMap extends SagaCommandMap = SagaCommandMap> {
  initialState: SagaInitialStateFactory<TState>;
  correlations: Array<{ aggregate: string; correlate: SagaCorrelationFactory }>;
  handlers: Array<{ aggregate: string; handlers: SagaHandlers<TState, TCommandMap> }>;
}

/** Fluent builder for composing a saga definition. */
export interface SagaBuilder<TState = unknown, TCommandMap extends SagaCommandMap = SagaCommandMap> {
  initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>): SagaBuilder<TNextState, TCommandMap>;
  correlate(aggregate: string, correlate: SagaCorrelationFactory): SagaBuilder<TState, TCommandMap>;
  on(aggregate: string, handlers: SagaHandlers<TState, TCommandMap>): SagaBuilder<TState, TCommandMap>;
  build(): SagaDefinition<TState, TCommandMap>;
}

interface SagaDefinitionDraft<TCommandMap extends SagaCommandMap> {
  initialState: SagaInitialStateFactory<unknown>;
  correlations: Array<{ aggregate: string; correlate: SagaCorrelationFactory }>;
  handlers: Array<{ aggregate: string; handlers: SagaHandlers<unknown, TCommandMap> }>;
}

function createSagaBuilder<TState, TCommandMap extends SagaCommandMap>(
  state: SagaDefinitionDraft<TCommandMap>
): SagaBuilder<TState, TCommandMap> {
  return {
    initialState<TNextState>(factory: SagaInitialStateFactory<TNextState>) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return createSagaBuilder<TNextState, TCommandMap>(state);
    },
    correlate(aggregate, correlate) {
      state.correlations.push({ aggregate, correlate });
      return createSagaBuilder<TState, TCommandMap>(state);
    },
    on(aggregate, handlers) {
      state.handlers.push({
        aggregate,
        handlers: handlers as SagaHandlers<unknown, TCommandMap>
      });
      return createSagaBuilder<TState, TCommandMap>(state);
    },
    build() {
      return state as SagaDefinition<TState, TCommandMap>;
    }
  };
}

/**
 * Creates a fluent saga builder with typed command-intent inference.
 *
 * `createSaga` defines state shape, correlation hooks, and handler contracts.
 * Execution, persistence, replay, and worker orchestration are provided by
 * companion saga modules exported from `src/sagas`.
 */
export function createSaga<TCommandMap extends SagaCommandMap = SagaCommandMap>(): SagaBuilder<
  unknown,
  TCommandMap
> {
  const state: SagaDefinitionDraft<TCommandMap> = {
    initialState: () => undefined,
    correlations: [],
    handlers: []
  };

  return createSagaBuilder<unknown, TCommandMap>(state);
}
