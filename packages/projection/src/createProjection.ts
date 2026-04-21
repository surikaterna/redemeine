import { ProjectionEvent as BaseProjectionEvent } from './types';

type Draft<TState> = TState;

/** Hooks for cross-cutting projection concerns (e.g., metadata tracking) */
export interface ProjectionHooks<TState> {
  /** Runs after every event handler — receives mutable state and the raw event */
  afterEach?: (state: TState, event: BaseProjectionEvent) => void;
}

/**
 * Event shape passed to projection handlers with narrowed payload type.
 */
type HandlerEvent<TPayload, TType extends string> = Omit<BaseProjectionEvent, 'payload' | 'type'> & {
  payload: TPayload;
  type: TType;
};

type AnyProjector = (...args: any[]) => unknown;

type ProjectorPayload<TProjector> =
  TProjector extends (state: any, event: infer TEvent, ...args: any[]) => unknown
    ? TEvent extends { payload: infer TPayload }
      ? TPayload
      : unknown
    : unknown;

type EventProjectorsOf<TAggregate> =
  TAggregate extends { pure: { eventProjectors: infer TProjectors } }
    ? TProjectors extends Record<string, AnyProjector>
      ? TProjectors
      : never
    : never;

type ProjectionAggregateSource = {
  aggregateType: string;
  pure: {
    eventProjectors: Record<string, unknown>;
  };
};

/** Extended source required for mirror — provides draft mutation and initial state */
export type MirrorableAggregateSource = ProjectionAggregateSource & {
  initialState: unknown;
  applyToDraft: (draft: any, event: any) => void;
};

/** Extract the state type from an aggregate that exposes initialState */
export type AggregateStateOf<T> = T extends { initialState: infer S } ? S : never;

/**
 * Extract aggregate event payload map from real `createAggregate(...).build()` outputs.
 * Falls back to explicit AggregateDefinition generic payloads for compatibility.
 */
export type AggregateEventPayloadMap<TAggregate> =
  [EventProjectorsOf<TAggregate>] extends [never]
    ? TAggregate extends AggregateDefinition<unknown, infer TPayloads>
      ? TPayloads
      : Record<string, unknown>
    : {
      [K in keyof EventProjectorsOf<TAggregate> & string]: ProjectorPayload<EventProjectorsOf<TAggregate>[K]>;
    };

/**
 * Event keys for an aggregate derived from event payload map.
 */
export type AggregateEventKeys<TAggregate> = keyof AggregateEventPayloadMap<TAggregate> & string;

/**
 * Payload type for a specific aggregate event key.
 */
export type AggregateEventPayloadByKey<
  TAggregate,
  TEventKey extends AggregateEventKeys<TAggregate>
> = AggregateEventPayloadMap<TAggregate>[TEventKey];

type AggregateTypeOf<TAggregate> =
  TAggregate extends { aggregateType: infer TAggregateType extends string }
    ? TAggregateType
    : string;

type CanonicalEventTypeByKey<TAggregate, TEventKey extends string> =
  `${AggregateTypeOf<TAggregate>}.${TEventKey}.event`;

type HandlerEventTypeByKey<TAggregate, TEventKey extends string> =
  TEventKey | CanonicalEventTypeByKey<TAggregate, TEventKey>;

/**
 * Aggregate definition interface - defines an aggregate that can be used in projections
 */
export interface AggregateDefinition<TState, TPayloads extends Record<string, unknown>> {
  aggregateType: string;
  initialState: TState;
  pure: {
    eventProjectors: Record<string, Function>;
  };
  metadata?: {
    commands?: Record<string, unknown>;
    events?: Record<string, unknown>;
  };
}

/**
 * Context passed to projection handlers
 */
export interface ProjectionContext {
  subscribeTo(aggregate: { aggregateType: string }, aggregateId: string): void;
  unsubscribeFrom(aggregate: { aggregateType: string }, aggregateId: string): void;
}

/**
 * Handler function for processing events in a projection
 */
export type ProjectionHandler<TState, TEvent extends BaseProjectionEvent = BaseProjectionEvent> = (
  state: Draft<TState>,
  event: TEvent,
  context: ProjectionContext
) => void;

/**
 * Projection handlers map - keyed by event type
 */
export type ProjectionHandlers<TState, TPayloads extends Record<string, unknown>> = {
  [K in keyof TPayloads & string]?: ProjectionHandler<
    TState,
    HandlerEvent<
      NonNullable<TPayloads[K]>,
      HandlerEventTypeByKey<unknown, K>
    >
  >;
};

type ProjectionHandlersForAggregate<TState, TAggregate> = {
  [K in AggregateEventKeys<TAggregate>]?: ProjectionHandler<
    TState,
    HandlerEvent<
      NonNullable<AggregateEventPayloadByKey<TAggregate, K>>,
      HandlerEventTypeByKey<TAggregate, K>
    >
  >;
};

// --- inherit token ---

const INHERIT_BRAND = Symbol('inherit');

export interface InheritExtended<TState = any, TEvent = any> {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  readonly after: (state: Draft<TState>, event: TEvent, context: ProjectionContext) => void;
}

export interface InheritToken {
  readonly __inheritBrand: typeof INHERIT_BRAND;
  extend<TState, TEvent>(
    after: (state: Draft<TState>, event: TEvent, context: ProjectionContext) => void
  ): InheritExtended<TState, TEvent>;
}

export const inherit: InheritToken = Object.freeze({
  __inheritBrand: INHERIT_BRAND,
  extend<TState, TEvent>(
    after: (state: Draft<TState>, event: TEvent, context: ProjectionContext) => void
  ): InheritExtended<TState, TEvent> {
    return Object.freeze({ __inheritBrand: INHERIT_BRAND, after });
  }
}) as InheritToken;

function isInheritEntry(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    '__inheritBrand' in value && (value as any).__inheritBrand === INHERIT_BRAND;
}

function isInheritExtended(value: unknown): value is InheritExtended {
  return isInheritEntry(value) && 'after' in (value as any);
}

type InheritableHandlersForAggregate<TState, TAggregate> = {
  [K in AggregateEventKeys<TAggregate>]?:
    | ProjectionHandler<
        TState,
        HandlerEvent<
          NonNullable<AggregateEventPayloadByKey<TAggregate, K>>,
          HandlerEventTypeByKey<TAggregate, K>
        >
      >
    | InheritToken
    | InheritExtended<
        TState,
        HandlerEvent<
          NonNullable<AggregateEventPayloadByKey<TAggregate, K>>,
          HandlerEventTypeByKey<TAggregate, K>
        >
      >;
};

// --- Stream / definition types ---

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
}

function defaultIdentity(event: BaseProjectionEvent): string {
  return event.aggregateId;
}

// --- Builder interface ---

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

  build(): ProjectionDefinition<TState>;
}

// --- Builder implementation ---

class ProjectionBuilderImpl<TState> implements ProjectionBuilder<TState> {
  private _name: string;
  private _initialState: ((id: string) => TState) | undefined;
  private _identity: (event: BaseProjectionEvent) => string | readonly string[];
  private _fromStream: ProjectionStreamDefinition<TState> | null = null;
  private _joinStreams: JoinStreamDefinition<TState>[] = [];
  private _hooks: ProjectionHooks<TState> = {};

  constructor(name: string, initialState?: (id: string) => TState) {
    this._name = name;
    this._initialState = initialState;
    this._identity = defaultIdentity;
  }

  initialState(fn: (id: string) => TState): ProjectionBuilder<TState> {
    this._initialState = fn;
    return this;
  }

  identity(fn: (event: BaseProjectionEvent) => string | readonly string[]): ProjectionBuilder<TState> {
    this._identity = fn;
    return this;
  }

  private _resolveHandlers(
    aggregate: ProjectionAggregateSource,
    handlers: Record<string, unknown>
  ): Record<string, ProjectionHandler<TState>> {
    const resolved: Record<string, ProjectionHandler<TState>> = {};
    const mirrorable = aggregate as unknown as MirrorableAggregateSource;

    for (const [key, value] of Object.entries(handlers)) {
      if (!value) continue;

      if (isInheritExtended(value)) {
        if (!mirrorable.applyToDraft) {
          throw new Error(
            `Projection '${this._name}': inherit requires an aggregate with applyToDraft.`
          );
        }
        const afterFn = value.after;
        resolved[key] = ((draft: any, event: any, context: any) => {
          mirrorable.applyToDraft(draft, event);
          afterFn(draft, event, context);
        }) as ProjectionHandler<TState>;
      } else if (isInheritEntry(value)) {
        if (!mirrorable.applyToDraft) {
          throw new Error(
            `Projection '${this._name}': inherit requires an aggregate with applyToDraft.`
          );
        }
        resolved[key] = ((draft: any, event: any) => {
          mirrorable.applyToDraft(draft, event);
        }) as ProjectionHandler<TState>;
      } else {
        resolved[key] = value as ProjectionHandler<TState>;
      }
    }

    return resolved;
  }

  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: any
  ): ProjectionBuilder<TState> {
    const handlersMap = this._resolveHandlers(aggregate, handlers);

    this._fromStream = {
      aggregate,
      handlers: handlersMap
    };

    return this;
  }

  mirror<TAggregate extends MirrorableAggregateSource>(
    aggregate: TAggregate,
    handlers?: any
  ): ProjectionBuilder<AggregateStateOf<TAggregate>> {
    const allKeys = Object.keys(aggregate.pure.eventProjectors);
    const explicit = handlers ? { ...handlers } : {};

    // Default unlisted keys to inherit
    for (const key of allKeys) {
      if (!(key in explicit)) {
        explicit[key] = inherit;
      }
    }

    const resolved = this._resolveHandlers(aggregate, explicit);

    this._fromStream = {
      aggregate,
      handlers: resolved as any
    };

    if (!this._initialState) {
      this._initialState = ((_id: string) =>
        structuredClone(aggregate.initialState)) as any;
    }

    return this as unknown as ProjectionBuilder<AggregateStateOf<TAggregate>>;
  }

  join<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};

    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) {
        handlersMap[key as string] = handler as ProjectionHandler<TState>;
      }
    }

    this._joinStreams.push({
      aggregate,
      handlers: handlersMap
    });

    return this;
  }

  hooks(hooks: ProjectionHooks<TState>): ProjectionBuilder<TState> {
    this._hooks = { ...this._hooks, ...hooks };
    return this;
  }

  build(): ProjectionDefinition<TState> {
    if (!this._fromStream) {
      throw new Error(`Projection '${this._name}' must have at least one .from() stream`);
    }

    if (!this._initialState) {
      throw new Error(
        `Projection '${this._name}' requires an initial state. ` +
        `Use .mirror() or createProjection(name, fn) to provide one.`
      );
    }

    return {
      name: this._name,
      fromStream: this._fromStream,
      joinStreams: this._joinStreams,
      initialState: this._initialState,
      identity: this._identity,
      subscriptions: [],
      hooks: this._hooks
    };
  }
}

// --- Factory function ---

export function createProjection<TState>(
  name: string,
  initialState: (id: string) => TState
): ProjectionBuilder<TState>;
export function createProjection(name: string): ProjectionBuilder<unknown>;
export function createProjection<TState = unknown>(
  name: string,
  initialState?: (id: string) => TState
): ProjectionBuilder<TState> {
  return new ProjectionBuilderImpl(name, initialState);
}
