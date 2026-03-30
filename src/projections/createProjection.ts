import { Draft } from 'immer';
import { ProjectionEvent } from './types';

/**
 * Handler function for processing events in a projection
 */
export type ProjectionHandler<TState, TEvent extends ProjectionEvent = ProjectionEvent> = (
  state: Draft<TState>,
  event: TEvent,
  context: ProjectionContext
) => void;

/**
 * Stream definition for projection source
 */
export interface ProjectionStreamDefinition<TState> {
  /** The aggregate type for this stream */
  aggregate: { __aggregateType: string };
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
}

/**
 * Create a projection definition
 * This is the main API for defining projections
 */
export function createProjection<TState>(
  name: string,
  config: {
    from: ProjectionStreamDefinition<TState>;
    join?: JoinStreamDefinition<TState>[];
    initialState: (documentId: string) => TState;
  }
): ProjectionDefinition<TState> {
  return {
    name,
    fromStream: config.from,
    joinStreams: config.join,
    initialState: config.initialState
  };
}
