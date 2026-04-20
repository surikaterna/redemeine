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

/** Extended source required for mirror/fallback — provides draft mutation and initial state */
export type MirrorableAggregateSource = ProjectionAggregateSource & {
  initialState: unknown;
  applyToDraft: (draft: any, event: any) => void;
};

/** Extract the state type from an aggregate that exposes initialState */
export type AggregateStateOf<T> = T extends { initialState: infer S } ? S : never;

/** Options for createProjection.mirror() */
export interface MirrorOptions<TState, TAggregate> {
  overrides?: ProjectionHandlersForAggregate<TState, TAggregate>;
}

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
  /**
   * Subscribe to events from another aggregate
   * Used for .join semantics to correlate related aggregates
   */
  subscribeTo(aggregate: { aggregateType: string }, aggregateId: string): void;

  /**
   * Remove a prior subscription for a related aggregate stream.
   */
  unsubscribeFrom(aggregate: { aggregateType: string }, aggregateId: string): void;

  /**
   * Internal runtime state is intentionally not exposed on public context.
   */
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

/**
 * Stream definition for projection source
 */
export interface ProjectionStreamDefinition<TState> {
  /** The aggregate type for this stream */
  aggregate: { aggregateType: string };
  /** Event handlers keyed by event type */
  handlers: Record<string, ProjectionHandler<TState>>;
}

/**
 * Join stream definition for related aggregates
 */
export interface JoinStreamDefinition<TState> {
  /** The aggregate type for this joined stream */
  aggregate: { aggregateType: string };
  /** Event handlers keyed by event type */
  handlers: Record<string, ProjectionHandler<TState>>;
}

/**
 * Complete projection definition
 */
export interface ProjectionDefinition<TState = unknown> {
  /** Unique name for this projection */
  name: string;
  /** The primary stream to project from (.from) */
  fromStream: ProjectionStreamDefinition<TState>;
  /** Additional streams to join (.join) */
  joinStreams?: JoinStreamDefinition<TState>[];
  /** Initial state factory function */
  initialState: (documentId: string) => TState;
  /** Identity resolver - determines which document ID(s) receive an event */
  identity: (event: BaseProjectionEvent) => string | readonly string[];
  /** Subscriptions captured during projection definition */
  subscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
  /** Cross-cutting hooks that run around event handlers */
  hooks?: ProjectionHooks<TState>;
}

/**
 * Default identity resolver - uses event's aggregateId
 */
function defaultIdentity(event: BaseProjectionEvent): string {
  return event.aggregateId;
}

/**
 * Builder interface for creating projections fluently
 */
export interface ProjectionBuilder<TState> {
  /**
   * Override the initial state factory
   */
  initialState(fn: (id: string) => TState): ProjectionBuilder<TState>;
  
  /**
   * Override the default identity resolver
   */
  identity(fn: (event: BaseProjectionEvent) => string | readonly string[]): ProjectionBuilder<TState>;
  
  /**
   * Define the primary stream to project from
   */
  from<TAggregate extends ProjectionAggregateSource, H extends ProjectionHandlersForAggregate<TState, TAggregate>>(
    aggregate: TAggregate,
    handlers: H,
    options?: {
      fallback?: TAggregate extends MirrorableAggregateSource
        ? { [K in Exclude<AggregateEventKeys<TAggregate>, keyof H & string>]?: true }
        : never;
    }
  ): ProjectionBuilder<TState>;
  
  /**
   * Add a joined stream for correlating related aggregates
   */
  join<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;
  
  /**
   * Register cross-cutting hooks that run around event handlers
   */
  hooks(hooks: ProjectionHooks<TState>): ProjectionBuilder<TState>;

  /**
   * Build the final projection definition
   */
  build(): ProjectionDefinition<TState>;
}

/**
 * Internal builder implementation
 */
class ProjectionBuilderImpl<TState> implements ProjectionBuilder<TState> {
  private _name: string;
  private _initialState: (id: string) => TState;
  private _identity: (event: BaseProjectionEvent) => string | readonly string[];
  private _fromStream: ProjectionStreamDefinition<TState> | null = null;
  private _joinStreams: JoinStreamDefinition<TState>[] = [];
  private _hooks: ProjectionHooks<TState> = {};

  constructor(name: string, initialState: (id: string) => TState) {
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

  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: any,
    options?: { fallback?: Record<string, true> }
  ): ProjectionBuilder<TState> {
    // Convert handlers to the required format
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};
    
    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) {
        handlersMap[key as string] = handler as ProjectionHandler<TState>;
      }
    }

    // Register fallback handlers from aggregate
    if (options?.fallback) {
      const mirrorable = aggregate as unknown as MirrorableAggregateSource;
      if (!mirrorable.applyToDraft) {
        throw new Error(
          'Fallback requires an aggregate with applyToDraft. Use createAggregate(...).build() to produce one.'
        );
      }

      for (const key of Object.keys(options.fallback)) {
        if (key in handlersMap) {
          throw new Error(
            `Projection '${this._name}': event '${key}' cannot appear in both handlers and fallback. ` +
            `Declare it in one place only.`
          );
        }
        if (!(key in aggregate.pure.eventProjectors)) {
          throw new Error(
            `Projection '${this._name}': fallback event '${key}' does not exist on aggregate '${aggregate.aggregateType}'.`
          );
        }
        handlersMap[key] = ((draft: any, event: any) => {
          mirrorable.applyToDraft(draft, event);
        }) as ProjectionHandler<TState>;
      }
    }

    this._fromStream = {
      aggregate: aggregate,
      handlers: handlersMap
    };
    
    return this;
  }

  join<TAggregate extends { aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    // Convert handlers to the required format
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

/**
 * Create a mirror projection that reuses aggregate event projectors.
 * Returns a ProjectionDefinition directly (no builder chain needed).
 */
function mirror<TAggregate extends MirrorableAggregateSource>(
  aggregate: TAggregate,
  name: string,
  options?: MirrorOptions<AggregateStateOf<TAggregate>, TAggregate>
): ProjectionDefinition<AggregateStateOf<TAggregate>> {
  const overrides = (options?.overrides || {}) as Record<string, ProjectionHandler<any>>;
  const projectorKeys = Object.keys(aggregate.pure.eventProjectors);

  const handlers: Record<string, ProjectionHandler<any>> = {};
  for (const key of projectorKeys) {
    if (key in overrides) {
      handlers[key] = overrides[key];
    } else {
      handlers[key] = (draft, event) => {
        aggregate.applyToDraft(draft, event);
      };
    }
  }

  return {
    name,
    fromStream: {
      aggregate,
      handlers
    },
    joinStreams: [],
    initialState: (_id: string) => structuredClone(aggregate.initialState) as AggregateStateOf<TAggregate>,
    identity: defaultIdentity,
    subscriptions: [],
    hooks: undefined
  };
}

/**
 * Create a projection definition using the fluent builder API.
 * 
 * @example
 * createProjection('invoice-summary', () => ({ id: '', amount: 0 }))
 *   .from(invoiceAgg, {
 *     created: (state, event) => { state.id = event.payload.customerId; }
 *   })
 *   .join(orderAgg, {
 *     shipped: (state, event) => { /* handle shipment *\/ }
 *   })
 *   .build()
 */
function _createProjection<TState>(
  name: string,
  initialState: (id: string) => TState
): ProjectionBuilder<TState> {
  return new ProjectionBuilderImpl(name, initialState);
}

export const createProjection = Object.assign(_createProjection, { mirror });
