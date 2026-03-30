import { produce, Draft } from 'immer';
import type { ProjectionEvent, Checkpoint } from './types';

// Re-export for convenience
export type { ProjectionEvent, Checkpoint } from './types';

/**
 * Type helper to extract the event payload type from an aggregate's event projector functions.
 * Maps each event handler key to its payload type.
 */
export type ExtractEventPayloads<THandlers> = {
  [K in keyof THandlers]: THandlers[K] extends (state: any, event: ProjectionEvent<infer P>) => void
    ? P
    : never;
};

/**
 * Handler function signature for projection event handlers.
 * The state is wrapped with Immer's Draft type, allowing direct mutations.
 */
export type ProjectionHandler<TState, TPayload = unknown> = (
  state: Draft<TState>,
  event: ProjectionEvent<TPayload>
) => void;

/**
 * Event handlers map type.
 * Maps event type names to their handler functions.
 * Supports partial handlers - you don't need to handle every event from the aggregate.
 */
export type ProjectionHandlers<
  TState,
  TPayloads extends Record<string, unknown> = Record<string, unknown>
> = Partial<{
  [K in keyof TPayloads]: ProjectionHandler<TState, TPayloads[K]>;
}>;

/**
 * Aggregate definition type (simplified from createAggregate).
 * Represents an aggregate that can be used as a stream source for projections.
 */
export interface AggregateDefinition<
  S = unknown,
  E extends Record<string, unknown> = Record<string, unknown>
> {
  readonly __aggregateType: string;
  readonly initialState: S;
  readonly pure?: {
    eventProjectors: Record<string, Function>;
  };
  readonly metadata?: {
    events: Record<string, { meta?: Record<string, unknown> }>;
  };
}

/**
 * Context object available in handler functions.
 * Provides utilities like subscribeTo for composite projections.
 */
export interface ProjectionContext<TState = unknown> {
  /**
   * Subscribe to events from another aggregate.
   * This creates a dynamic link that allows .join events to be processed.
   *
   * @param aggregate The aggregate definition (e.g., invoiceAgg)
   * @param aggregateId The specific aggregate instance ID to subscribe to
   */
  subscribeTo: (aggregate: AggregateDefinition, aggregateId: string) => void;

  /**
   * Get current subscriptions for this projection (internal use)
   */
  getSubscriptions: () => Array<{ aggregate: AggregateDefinition; aggregateId: string }>;
}

/**
 * Builder interface for creating projections.
 * Provides a fluent API to chain configuration methods.
 */
export interface ProjectionBuilder<TState> {
  /**
   * Define the initial/default state for this projection.
   * Called automatically when a document doesn't exist yet.
   */
  initialState(fn: (id: string) => TState): ProjectionBuilder<TState>;

  /**
   * Optional: Override the default identity resolution.
   * By default, the projection document ID comes from the primary aggregate's aggregateId.
   */
  identity(fn: (event: ProjectionEvent) => string): ProjectionBuilder<TState>;

  /**
   * Define the PRIMARY stream - events that OWN the projection document.
   * Events from this stream dictate document creation lifecycle.
   * The aggregateId of these events becomes the document ID automatically.
   *
   * @param aggregate The aggregate definition (e.g., invoiceAgg)
   * @param handlers Event handlers keyed by event type name (partial - not all events required)
   */
  from<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: Partial<{ [K in keyof TPayloads]: ProjectionHandler<TState, TPayloads[K]> }>
  ): ProjectionBuilder<TState>;

  /**
   * Define a SECONDARY/JOIN stream - supplementary data from other aggregates.
   * Events from these streams CANNOT create documents.
   * They are only processed if subscribeTo() was called for that aggregate+id.
   *
   * @param aggregate The aggregate definition (e.g., orderAgg)
   * @param handlers Event handlers keyed by event type name (partial - not all events required)
   */
  join<TPayloads extends Record<string, unknown>>(
    aggregate: AggregateDefinition<unknown, TPayloads>,
    handlers: Partial<{ [K in keyof TPayloads]: ProjectionHandler<TState, TPayloads[K]> }>
  ): ProjectionBuilder<TState>;

  /**
   * Finalize and build the projection definition
   */
  build(): ProjectionDefinition<TState>;
}

/**
 * Built projection definition (immutable).
 * This is the final output of the builder, containing all configuration.
 */
export interface ProjectionDefinition<TState = unknown> {
  readonly name: string;
  readonly initialState: (id: string) => TState;
  readonly identity: (event: ProjectionEvent) => string;
  readonly fromStream: {
    aggregate: AggregateDefinition;
    handlers: Record<string, Function>;
  };
  readonly joinStreams: Array<{
    aggregate: AggregateDefinition;
    handlers: Record<string, Function>;
  }>;
  readonly subscriptions: Array<{ aggregate: AggregateDefinition; aggregateId: string }>;
}

/**
 * Internal state for the projection builder.
 */
interface ProjectionBuilderState<TState> {
  name: string;
  initialStateFn: (id: string) => TState;
  identityFn: (event: ProjectionEvent) => string;
  fromAggregate?: AggregateDefinition;
  fromHandlers: Record<string, Function>;
  joinAggregates: Array<{
    aggregate: AggregateDefinition;
    handlers: Record<string, Function>;
  }>;
  subscriptions: Array<{ aggregate: AggregateDefinition; aggregateId: string }>;
}

/**
 * Configuration object for createProjection (legacy/config API)
 */
interface ProjectionConfig<TState> {
  from: {
    aggregate: AggregateDefinition;
    handlers: Record<string, Function>;
  };
  join?: Array<{
    aggregate: AggregateDefinition;
    handlers: Record<string, Function>;
  }>;
  initialState: ((id: string) => TState) | TState;
  identity?: (event: ProjectionEvent) => string;
}

/**
 * Type guard to check if the second argument is a config object
 */
function isProjectionConfig<TState>(arg: unknown): arg is ProjectionConfig<TState> {
  return typeof arg === 'object' && arg !== null && 'from' in arg;
}

/**
 * Create a new projection builder.
 * 
 * Supports two APIs:
 * 1. Builder API: createProjection('name', () => ({...})).from(agg, {...}).join(agg, {...}).build()
 * 2. Config API: createProjection('name', { from: {...}, initialState: {...} })
 * 
 * @example
 * const invoiceProjection = createProjection('invoice-summary', () => ({ total: 0, items: [] }))
 *   .from(invoiceAgg, {
 *     created: (state, event) => { state.total = event.payload.amount; }
 *   })
 *   .build();
 * 
 * @example
 * // With strict type inference - event.payload types are automatically inferred:
 * const invoiceProjection = createProjection('invoice-summary', () => ({ total: 0, items: [] }))
 *   .from(invoiceAgg, {
 *     created: (state, event) => { 
 *       // event.payload is automatically typed as InvoiceCreatedPayload
 *       state.total = event.payload.amount;
 *     },
 *     paid: (state, event) => {
 *       // event.payload is automatically typed as InvoicePaidPayload
 *     }
 *   })
 *   .join(orderAgg, {
 *     shipped: (state, event) => {
 *       // event.payload is automatically typed as OrderShippedPayload
 *     }
 *   })
 *   .build();
 */
// Overload for config-based API (legacy)
export function createProjection<TState>(
  name: string,
  config: ProjectionConfig<TState>
): ProjectionDefinition<TState>;

// Overload for builder API
export function createProjection<TState>(
  name: string,
  initialStateOrFn: TState | ((id: string) => TState)
): ProjectionBuilder<TState>;

// Implementation
export function createProjection<TState>(
  name: string,
  initialStateOrConfig: unknown
): ProjectionBuilder<TState> | ProjectionDefinition<TState> {
  // Detect config object (legacy API) vs builder API
  if (isProjectionConfig<TState>(initialStateOrConfig)) {
    // Config API - return ProjectionDefinition directly
    const config = initialStateOrConfig as ProjectionConfig<TState>;
    const initialStateFn = typeof config.initialState === 'function'
      ? config.initialState as (id: string) => TState
      : () => config.initialState as TState;
    
    return {
      name,
      initialState: initialStateFn,
      identity: config.identity || ((event: ProjectionEvent) => event.aggregateId),
      fromStream: config.from,
      joinStreams: config.join || [],
      subscriptions: []
    };
  }

  // Builder API - cast to expected type
  const initialStateOrFn = initialStateOrConfig as (id: string) => TState | TState;
  // Resolve initial state - can be a value or a function
  const initialStateFn: (id: string) => TState =
    typeof initialStateOrFn === 'function'
      ? initialStateOrFn
      : () => initialStateOrFn as TState;

  // Internal mutable state
  const state: ProjectionBuilderState<TState> = {
    name,
    initialStateFn,
    identityFn: (event: ProjectionEvent) => event.aggregateId,
    fromHandlers: {},
    joinAggregates: [],
    subscriptions: []
  };

  // Create context object for handlers
  const createContext = (): ProjectionContext<TState> => ({
    subscribeTo: (aggregate: AggregateDefinition, aggregateId: string) => {
      // Check if subscription already exists
      const exists = state.subscriptions.some(
        (s) => s.aggregate === aggregate && s.aggregateId === aggregateId
      );
      if (!exists) {
        state.subscriptions.push({ aggregate, aggregateId });
      }
    },
    getSubscriptions: () => [...state.subscriptions]
  });

  const builder: ProjectionBuilder<TState> = {
    initialState(fn: (id: string) => TState): ProjectionBuilder<TState> {
      state.initialStateFn = fn;
      return builder;
    },

    identity(fn: (event: ProjectionEvent) => string): ProjectionBuilder<TState> {
      state.identityFn = fn;
      return builder;
    },

    from<TPayloads extends Record<string, unknown>>(
      aggregate: AggregateDefinition<unknown, TPayloads>,
      handlers: ProjectionHandlers<TState, TPayloads>
    ): ProjectionBuilder<TState> {
      state.fromAggregate = aggregate;
      
      // Wrap handlers with Immer's produce for immutable state updates
      Object.entries(handlers).forEach(([eventType, handler]) => {
        state.fromHandlers[eventType] = (state: Draft<TState>, event: ProjectionEvent) => {
          produce(state, (draft) => {
            handler(draft, event);
          });
        };
      });
      
      return builder;
    },

    join<TPayloads extends Record<string, unknown>>(
      aggregate: AggregateDefinition<unknown, TPayloads>,
      handlers: ProjectionHandlers<TState, TPayloads>
    ): ProjectionBuilder<TState> {
      // Wrap handlers with Immer's produce for immutable state updates
      const wrappedHandlers: Record<string, Function> = {};
      Object.entries(handlers).forEach(([eventType, handler]) => {
        wrappedHandlers[eventType] = (state: Draft<TState>, event: ProjectionEvent) => {
          produce(state, (draft) => {
            handler(draft, event);
          });
        };
      });
      
      state.joinAggregates.push({
        aggregate,
        handlers: wrappedHandlers
      });
      
      return builder;
    },

    build(): ProjectionDefinition<TState> {
      if (!state.fromAggregate) {
        throw new Error(
          `Projection '${name}' must have at least one .from() stream. ` +
          `Use .from(aggregate, handlers) to define the primary event stream.`
        );
      }

      return {
        name: state.name,
        initialState: state.initialStateFn,
        identity: state.identityFn,
        fromStream: {
          aggregate: state.fromAggregate,
          handlers: state.fromHandlers
        },
        joinStreams: [...state.joinAggregates],
        subscriptions: [...state.subscriptions]
      };
    }
  };

  return builder;
}

/**
 * Helper function to create a projection that wraps an aggregate's event projectors.
 * This simplifies projection creation for aggregates that already define event projectors.
 * 
 * @param name Projection name
 * @param aggregate The source aggregate
 * @param initialState Initial state value or factory function
 */
export function projectFromAggregate<
  TState,
  TEventPayloads extends Record<string, unknown>
>(
  name: string,
  aggregate: AggregateDefinition<TState, TEventPayloads>,
  initialState: TState | ((id: string) => TState)
): ProjectionBuilder<TState> {
  const stateFn =
    typeof initialState === 'function'
      ? (initialState as (id: string) => TState)
      : () => initialState;

  // Extract handlers from aggregate's event projectors
  const projectors = aggregate.pure?.eventProjectors || {};
  const handlers: ProjectionHandlers<TState, TEventPayloads> = {} as ProjectionHandlers<TState, TEventPayloads>;
  
  Object.keys(projectors).forEach((eventType) => {
    handlers[eventType as keyof TEventPayloads] = (
      state: Draft<TState>,
      event: ProjectionEvent<TEventPayloads[keyof TEventPayloads]>
    ) => {
      const projector = projectors[eventType];
      if (typeof projector === 'function') {
        // The projector may be a standard aggregate projector (state, event) => void
        // We wrap it with produce for the projection context
        produce(state, (draft) => {
          projector(draft as TState, event);
        });
      }
    };
  });

  return createProjection<TState>(name, stateFn).from(aggregate, handlers);
}
