import type {
  IEventSubscription,
  IProjectionStore,
  IProjectionLinkStore
} from '@redemeine/projection-runtime-core';
import type {
  ProjectionDefinition as RuntimeProjectionDefinition
} from '@redemeine/projection';

type Checkpoint = {
  sequence: number;
  timestamp?: string;
};

type ProjectionEvent = {
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

type ProjectionDefinition<TState = unknown> = RuntimeProjectionDefinition<TState>;

type ProjectionDaemonLike<TState> = {
  processBatch(): Promise<{ eventsProcessed: number }>;
};

type ProjectionRuntimeCoreModule = {
  ProjectionDaemon: new <TState extends Record<string, unknown>>(options: {
    projection: ProjectionDefinition<TState>;
    subscription: IEventSubscription;
    store: IProjectionStore<TState>;
    batchSize: number;
    linkStore: IProjectionLinkStore;
  }) => ProjectionDaemonLike<TState>;
};

type ProjectionRuntimeStoreInMemoryModule = {
  InMemoryProjectionStore: new <TState>() => IProjectionStore<TState>;
  InMemoryProjectionLinkStore: new () => IProjectionLinkStore;
};

export type ProjectionRuntimeModule = {
  core: ProjectionRuntimeCoreModule;
  inmemory: ProjectionRuntimeStoreInMemoryModule;
};

export type EventQueueSubscription = IEventSubscription & {
  push(events: readonly ProjectionEvent[]): void;
  hasPendingEventsAfter(cursor: Checkpoint): boolean;
};

export type ProjectionRuntime = {
  readonly projection: ProjectionDefinition<any>;
  readonly store: IProjectionStore<any>;
  readonly subscription: EventQueueSubscription;
  readonly daemon: ProjectionDaemonLike<any>;
};

async function dynamicImport(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

/**
 * Loads projection runtime modules without module-level caching.
 * Each depot gets its own import attempt via the caller's closure,
 * preventing a failed import from poisoning subsequent depot creations.
 */
export async function loadProjectionRuntimeModule(): Promise<ProjectionRuntimeModule> {
  try {
    const core = await dynamicImport('@redemeine/projection-runtime-core') as ProjectionRuntimeCoreModule;
    const inmemory = await dynamicImport('@redemeine/projection-runtime-store-inmemory') as ProjectionRuntimeStoreInMemoryModule;
    return { core, inmemory };
  } catch (packageImportError) {
    try {
      const core = await dynamicImport('../../projection-runtime-core/src/index') as ProjectionRuntimeCoreModule;
      const inmemory = await dynamicImport('../../projection-runtime-store-inmemory/src/index') as ProjectionRuntimeStoreInMemoryModule;
      return { core, inmemory };
    } catch (sourceImportError) {
      throw new Error(
        `createTestDepot: unable to load projection runtime v3 core/store-inmemory modules from package or workspace source. package error: ${String(packageImportError)}; source error: ${String(sourceImportError)}`
      );
    }
  }
}

export function createEventQueueSubscription(): EventQueueSubscription {
  let queue: ProjectionEvent[] = [];

  return {
    push(events) {
      queue.push(...events);
      queue = queue
        .slice()
        .sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp));
    },
    hasPendingEventsAfter(cursor) {
      return queue.some((event) => event.sequence > cursor.sequence);
    },
    async poll(cursor, batchSize) {
      const events = queue.filter((event) => event.sequence > cursor.sequence).slice(0, batchSize);
      const nextCursor = events.length > 0
        ? {
            sequence: events[events.length - 1]!.sequence,
            timestamp: events[events.length - 1]!.timestamp
          }
        : cursor;

      return {
        events,
        nextCursor
      };
    }
  };
}
