export type SagaInitialStateFactory<TState> = () => TState;

export type SagaCorrelationFactory = (...args: unknown[]) => unknown;

export type SagaCommandMap = Record<string, unknown>;

export type SagaCommandName<TCommandMap extends SagaCommandMap> = keyof TCommandMap & string;

export type SagaCommandPayload<
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
> = TCommandMap[TCommandName];

export interface SagaIntentMetadata {
  sagaId: string;
  correlationId: string;
  causationId: string;
}

export interface SagaDispatchIntent<
  TCommandMap extends SagaCommandMap,
  TCommandName extends SagaCommandName<TCommandMap>
> {
  type: 'dispatch';
  command: TCommandName;
  payload: SagaCommandPayload<TCommandMap, TCommandName>;
  metadata: SagaIntentMetadata;
}

export interface SagaScheduleIntent {
  type: 'schedule';
  id: string;
  delay: number;
  metadata: SagaIntentMetadata;
}

export interface SagaCancelScheduleIntent {
  type: 'cancel-schedule';
  id: string;
  metadata: SagaIntentMetadata;
}

export interface SagaRunActivityIntent<TResult = unknown> {
  type: 'run-activity';
  name: string;
  closure: SagaActivityClosure<TResult>;
  retryPolicy?: SagaRetryPolicy;
  metadata: SagaIntentMetadata;
}

export type SagaIntent =
  | SagaDispatchIntent<SagaCommandMap, string>
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent;

export type SagaDispatch<TCommandMap extends SagaCommandMap> = <
  TCommandName extends SagaCommandName<TCommandMap>
>(
  command: TCommandName,
  payload: SagaCommandPayload<TCommandMap, TCommandName>,
  metadata?: Partial<SagaIntentMetadata>
) => SagaDispatchIntent<TCommandMap, TCommandName>;

export interface SagaRetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffCoefficient: number;
  maxBackoffMs?: number;
  jitterCoefficient?: number;
}

export type SagaActivityClosure<TResult = unknown> = () => TResult | Promise<TResult>;

export type SagaRunActivity = <TResult = unknown>(
  name: string,
  closure: SagaActivityClosure<TResult>,
  retryPolicy?: SagaRetryPolicy,
  metadata?: Partial<SagaIntentMetadata>
) => SagaRunActivityIntent<TResult>;

export interface SagaDispatchContext<TState, TCommandMap extends SagaCommandMap> {
  readonly state: TState;
  readonly metadata: SagaIntentMetadata;
  dispatch: SagaDispatch<TCommandMap>;
  schedule: (id: string, delay: number, metadata?: Partial<SagaIntentMetadata>) => SagaScheduleIntent;
  cancelSchedule: (id: string, metadata?: Partial<SagaIntentMetadata>) => SagaCancelScheduleIntent;
  runActivity: SagaRunActivity;
}

export interface SagaStateTransition<TState> {
  readonly state: TState;
}

export type SagaDispatchIntent<TCommandMap extends SagaCommandMap> = {
  [TCommandName in SagaCommandName<TCommandMap>]: {
    readonly type: 'dispatch';
    readonly command: TCommandName;
    readonly payload: SagaCommandPayload<TCommandMap, TCommandName>;
  };
}[SagaCommandName<TCommandMap>];

export interface SagaScheduleIntent {
  readonly type: 'schedule';
  readonly id: string;
  readonly delay: number;
}

export interface SagaCancelScheduleIntent {
  readonly type: 'cancelSchedule';
  readonly id: string;
}

export interface SagaRunActivityIntent {
  readonly type: 'runActivity';
  readonly name: string;
  readonly retryPolicy?: SagaRetryPolicy;
}

export type SagaIntent<TCommandMap extends SagaCommandMap> =
  | SagaDispatchIntent<TCommandMap>
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent;

export interface SagaReducerOutput<TState, TCommandMap extends SagaCommandMap> extends SagaStateTransition<TState> {
  readonly intents: readonly SagaIntent<TCommandMap>[];
}

export type SagaHandlerResult<TState, TCommandMap extends SagaCommandMap> =
  | SagaReducerOutput<TState, TCommandMap>
  | Promise<SagaReducerOutput<TState, TCommandMap>>;

export type SagaHandler<TState, TCommandMap extends SagaCommandMap> = (
  ctx: SagaDispatchContext<TState, TCommandMap>,
  ...args: unknown[]
) => SagaHandlerResult<TState, TCommandMap>;

export type SagaHandlers<TState, TCommandMap extends SagaCommandMap> = Record<
  string,
  SagaHandler<TState, TCommandMap>
>;

export interface SagaDefinition<TState = unknown, TCommandMap extends SagaCommandMap = SagaCommandMap> {
  initialState: SagaInitialStateFactory<TState>;
  correlations: Array<{ aggregate: string; correlate: SagaCorrelationFactory }>;
  handlers: Array<{ aggregate: string; handlers: SagaHandlers<TState, TCommandMap> }>;
}

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
 * Scaffold for saga fluent API.
 * Runtime behavior is intentionally skeletal in S02.
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
