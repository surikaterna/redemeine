import { Draft } from 'immer';
import { ProjectionEvent as BaseProjectionEvent } from './types';

/**
 * Event shape passed to projection handlers with narrowed payload type.
 */
type HandlerEvent<TPayload> = Omit<BaseProjectionEvent, 'payload'> & { payload: TPayload };

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
  [K in keyof TPayloads]?: ProjectionHandler<TState, HandlerEvent<NonNullable<TPayloads[K]>>>;
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
  aggregate: AggregateDefinition<unknown, Record<string, unknown>>;
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
  /** Identity resolver - determines which document ID receives an event */
  identity: (event: BaseProjectionEvent) => string;
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
  identity(fn: (event: BaseProjectionEvent) => string): ProjectionBuilder<TState>;
  
  /**
   * Define the primary stream to project from
   */
  from<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: ProjectionHandlers<TState, TPayloads>
  ): ProjectionBuilder<TState>;
  
  /**
   * Add a joined stream for correlating related aggregates
   */
  join<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: ProjectionHandlers<TState, TPayloads>
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
  private _identity: (event: BaseProjectionEvent) => string;
  private _fromStream: ProjectionStreamDefinition<TState> | null = null;
  private _joinStreams: JoinStreamDefinition<TState>[] = [];

  constructor(name: string, initialState: (id: string) => TState) {
    this._name = name;
    this._initialState = initialState;

    this._identity = defaultIdentity;
  }

  initialState(fn: (id: string) => TState): ProjectionBuilder<TState> {
    this._initialState = fn;
    return this;
  }

  identity(fn: (event: BaseProjectionEvent) => string): ProjectionBuilder<TState> {
    this._identity = fn;
    return this;
  }

  from<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: ProjectionHandlers<TState, TPayloads>
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
      aggregate: aggregate as AggregateDefinition<unknown, Record<string, unknown>>,
      handlers: handlersMap
    };
    
    return this;
  }

  join<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: ProjectionHandlers<TState, TPayloads>
  ): ProjectionBuilder<TState> {
    // Convert handlers to the required format
    const handlersMap: Record<string, ProjectionHandler<TState>> = {};
    
    for (const [key, handler] of Object.entries(handlers)) {
      if (handler) {
        handlersMap[key as string] = handler as ProjectionHandler<TState>;
      }
    }

    this._joinStreams.push({
      aggregate: aggregate as AggregateDefinition<unknown, Record<string, unknown>>,
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
