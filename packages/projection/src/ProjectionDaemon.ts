import {
  ProjectionDaemon as CoreProjectionDaemon,
  type ProjectionDaemonOptions as CoreProjectionDaemonOptions,
  type BatchStats,
  type ProjectionDefinition,
  type IEventSubscription,
  type IProjectionStore,
  type IProjectionLinkStore
} from '@redemeine/projection-runtime-core';
import { InMemoryProjectionLinkStore } from './InMemoryProjectionLinkStore';

export interface ProjectionDaemonOptions<TState> {
  projection: ProjectionDefinition<TState>;
  subscription: IEventSubscription;
  store: IProjectionStore<TState>;
  batchSize?: number;
  pollInterval?: number;
  onBatch?: (stats: BatchStats) => void;
  linkStore?: IProjectionLinkStore;
}

/**
 * Compatibility wrapper preserving optional linkStore behavior.
 */
export class ProjectionDaemon<TState = unknown> extends CoreProjectionDaemon<TState> {
  constructor(options: ProjectionDaemonOptions<TState>) {
    super({
      ...options,
      linkStore: options.linkStore ?? new InMemoryProjectionLinkStore()
    } as CoreProjectionDaemonOptions<TState>);
  }
}

export type { BatchStats };
