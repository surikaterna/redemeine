// Types from types.ts (these are the canonical types for the system)
export type { Checkpoint, ProjectionEvent, EventBatch, Cursor } from './types';

// Interfaces
export type { IProjectionStore } from './IProjectionStore';
export type { IEventSubscription } from './IEventSubscription';

// Builder API - only export the builder-specific types (not the ones from types.ts)
export type { 
  AggregateDefinition,
  ProjectionBuilder,
  ProjectionDefinition,
  ProjectionContext,
  ProjectionHandler,
  ProjectionHandlers,
  ExtractEventPayloads
} from './createProjection';

export { createProjection, projectFromAggregate } from './createProjection';

// Daemon
export { ProjectionDaemon, type ProjectionDaemonOptions, type BatchStats } from './ProjectionDaemon';

// Store implementations
export { InMemoryProjectionStore } from './InMemoryProjectionStore';
