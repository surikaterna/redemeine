import type { ProjectionDeduplicationStrategy } from './deduplication';
import type { InheritExtended, InheritToken } from './inherit';
import type { ProjectionEvent as BaseProjectionEvent } from './types';

/** Hooks for cross-cutting projection concerns (e.g., metadata tracking) */
export interface ProjectionHooks<TState> {
  /** Runs after every event handler — receives mutable state and the raw event */
  afterEach?: (state: TState, event: BaseProjectionEvent) => void;
}

type HandlerEvent<TPayload, TType extends string> = Omit<BaseProjectionEvent, 'payload' | 'type'> & {
  payload: TPayload;
  type: TType;
};

type ProjectorPayload<TProjector> = TProjector extends (...args: infer TArgs) => unknown
  ? TArgs extends [unknown, infer TEvent, ...unknown[]]
    ? TEvent extends { payload: infer TPayload }
      ? TPayload
      : unknown
    : unknown
  : unknown;

type EventProjectorsOf<TAggregate> = TAggregate extends { pure: { eventProjectors: infer TProjectors } }
  ? TProjectors extends Record<string, CallableFunction>
    ? TProjectors
    : never
  : never;

export type ProjectionAggregateSource = {
  aggregateType: string;
  pure: { eventProjectors: Record<string, unknown> };
};

/** Extended source required for mirror — provides draft mutation and initial state */
export type MirrorableAggregateSource = ProjectionAggregateSource & {
  initialState: unknown;
  applyToDraft: CallableFunction;
};

/** Extract the state type from an aggregate that exposes initialState */
export type AggregateStateOf<T> = T extends { initialState: infer S } ? S : never;

/** Extract aggregate event payloads from built aggregates or explicit definitions. */
export type AggregateEventPayloadMap<TAggregate> = [EventProjectorsOf<TAggregate>] extends [never]
  ? TAggregate extends AggregateDefinition<unknown, infer TPayloads>
    ? TPayloads
    : Record<string, unknown>
  : {
      [K in keyof EventProjectorsOf<TAggregate> & string]: ProjectorPayload<EventProjectorsOf<TAggregate>[K]>;
    };

export type AggregateEventKeys<TAggregate> = keyof AggregateEventPayloadMap<TAggregate> & string;

export type AggregateEventPayloadByKey<TAggregate, TEventKey extends AggregateEventKeys<TAggregate>> = AggregateEventPayloadMap<TAggregate>[TEventKey];

type AggregateTypeOf<TAggregate> = TAggregate extends { aggregateType: infer TAggregateType extends string } ? TAggregateType : string;

type HandlerEventTypeByKey<TAggregate, TEventKey extends string> = TEventKey | `${AggregateTypeOf<TAggregate>}.${TEventKey}.event`;

export interface AggregateDefinition<TState, TPayloads extends Record<string, unknown>> {
  aggregateType: string;
  initialState: TState;
  pure: { eventProjectors: Record<string, CallableFunction> };
  metadata?: {
    commands?: Record<string, unknown>;
    events?: Record<string, unknown>;
  };
}

export interface ProjectionContext {
  subscribeTo(aggregate: { aggregateType: string }, aggregateId: string): void;
  unsubscribeFrom(aggregate: { aggregateType: string }, aggregateId: string): void;
}

export type ProjectionHandler<TState, TEvent extends BaseProjectionEvent = BaseProjectionEvent> = (
  state: TState,
  event: TEvent,
  context: ProjectionContext
) => void;

export type ProjectionHandlers<TState, TPayloads extends Record<string, unknown>> = {
  [K in keyof TPayloads & string]?: ProjectionHandler<TState, HandlerEvent<NonNullable<TPayloads[K]>, HandlerEventTypeByKey<unknown, K>>>;
};

type AggregateHandlerEvent<TAggregate, K extends AggregateEventKeys<TAggregate>> = HandlerEvent<
  NonNullable<AggregateEventPayloadByKey<TAggregate, K>>,
  HandlerEventTypeByKey<TAggregate, K>
>;

export type ProjectionHandlersForAggregate<TState, TAggregate> = {
  [K in AggregateEventKeys<TAggregate>]?: ProjectionHandler<TState, AggregateHandlerEvent<TAggregate, K>>;
};

export type InheritableHandlersForAggregate<TState, TAggregate> = {
  [K in AggregateEventKeys<TAggregate>]?:
    | ProjectionHandler<TState, AggregateHandlerEvent<TAggregate, K>>
    | InheritToken
    | InheritExtended<TState, AggregateHandlerEvent<TAggregate, K>>;
};

export interface ProjectionStreamDefinition<TState> {
  aggregate: { aggregateType: string };
  handlers: Record<string, ProjectionHandler<TState>>;
}

export interface JoinStreamDefinition<TState> {
  aggregate: { aggregateType: string };
  handlers: Record<string, ProjectionHandler<TState>>;
}

export interface ProjectionDefinition<TState = unknown> {
  name: string;
  fromStream: ProjectionStreamDefinition<TState>;
  joinStreams?: JoinStreamDefinition<TState>[];
  initialState: (documentId: string) => TState;
  identity: (event: BaseProjectionEvent) => string | readonly string[];
  subscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
  hooks?: ProjectionHooks<TState>;
  /** Required by commit-native runtimes. Omission is retained for legacy definitions only. */
  deduplication?: ProjectionDeduplicationStrategy;
}

export interface ProjectionCommitDefinition<TState = unknown> extends Omit<ProjectionDefinition<TState>, 'deduplication'> {
  deduplication: ProjectionDeduplicationStrategy;
}

export interface ProjectionBuilder<TState> {
  initialState(fn: (id: string) => TState): ProjectionBuilder<TState>;
  identity(fn: (event: BaseProjectionEvent) => string | readonly string[]): ProjectionBuilder<TState>;
  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: InheritableHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;
  join<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;
  mirror<TAggregate extends MirrorableAggregateSource>(
    aggregate: TAggregate,
    handlers?: InheritableHandlersForAggregate<AggregateStateOf<TAggregate>, TAggregate>
  ): ProjectionBuilder<AggregateStateOf<TAggregate>>;
  hooks(hooks: ProjectionHooks<TState>): ProjectionBuilder<TState>;
  deduplication(strategy: ProjectionDeduplicationStrategy): ProjectionCommitBuilder<TState>;
  build(): ProjectionDefinition<TState>;
}

export interface ProjectionCommitBuilder<TState> extends ProjectionBuilder<TState> {
  deduplication(strategy: ProjectionDeduplicationStrategy): ProjectionCommitBuilder<TState>;
  buildCommitDefinition(): ProjectionCommitDefinition<TState>;
}
