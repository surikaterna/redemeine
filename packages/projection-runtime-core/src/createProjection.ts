import type { Draft } from 'immer';
import { ProjectionEvent as BaseProjectionEvent } from './types';

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
  pure: {
    eventProjectors: Record<string, unknown>;
  };
};

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
  TAggregate extends { __aggregateType: infer TAggregateType extends string }
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
  __aggregateType: string;
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
  subscribeTo(aggregate: { __aggregateType: string }, aggregateId: string): void;

  /**
   * Remove a prior subscription for a related aggregate stream.
   */
  unsubscribeFrom(aggregate: { __aggregateType: string }, aggregateId: string): void;
  
  /**
   * Get current subscriptions
   */
  getSubscriptions(): Array<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
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
  aggregate: AggregateDefinition<unknown, Record<string, unknown>>;
  /** Event handlers keyed by event type */
  handlers: Record<string, ProjectionHandler<TState>>;
}

/**
 * Join stream definition for related aggregates
 */
export interface JoinStreamDefinition<TState> {
  /** The aggregate type for this joined stream */
  aggregate: { __aggregateType: string };
  /** Event handlers keyed by event type */
  handlers: Record<string, ProjectionHandler<TState>>;
}

/**
 * Reverse-subscribe stream definition for declarative reverse contracts.
 */
export interface ReverseSubscribeStreamDefinition<TState> {
  /** The aggregate type for this reverse stream */
  aggregate: { __aggregateType: string };
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
  /** Additional reverse-subscribe streams (.reverseSubscribe) */
  reverseSubscribeStreams?: ReverseSubscribeStreamDefinition<TState>[];
  /** Initial state factory function */
  initialState: (documentId: string) => TState;
  /** Identity resolver - determines which document ID(s) receive an event */
  identity: (event: BaseProjectionEvent) => string | readonly string[];
  /** Subscriptions captured during projection definition */
  subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
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
  from<TAggregate extends ProjectionAggregateSource>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;
  
  /**
   * Add a joined stream for correlating related aggregates
   */
  join<TAggregate extends { __aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;

  /**
   * Add a reverse-subscribe stream declaration.
   */
  reverseSubscribe<TAggregate extends { __aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState>;
  
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
  private _reverseSubscribeStreams: ReverseSubscribeStreamDefinition<TState>[] = [];

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
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    // Convert handlers to the required format
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};
    
    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) {
        // Wrap handler with Immer's produce for immutable updates
        handlersMap[key as string] = handler as ProjectionHandler<TState>;
      }
    }

    this._fromStream = {
      aggregate: aggregate as unknown as AggregateDefinition<unknown, Record<string, unknown>>,
      handlers: handlersMap
    };
    
    return this;
  }

  join<TAggregate extends { __aggregateType: string }>(
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

  reverseSubscribe<TAggregate extends { __aggregateType: string }>(
    aggregate: TAggregate,
    handlers: ProjectionHandlersForAggregate<TState, TAggregate>
  ): ProjectionBuilder<TState> {
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};

    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) {
        handlersMap[key as string] = handler as ProjectionHandler<TState>;
      }
    }

    this._reverseSubscribeStreams.push({
      aggregate,
      handlers: handlersMap
    });

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
      reverseSubscribeStreams: this._reverseSubscribeStreams,
      initialState: this._initialState,
      identity: this._identity,
      subscriptions: []
    };
  }
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
export function createProjection<TState>(
  name: string,
  initialState: (id: string) => TState
): ProjectionBuilder<TState> {
  return new ProjectionBuilderImpl(name, initialState);
}
