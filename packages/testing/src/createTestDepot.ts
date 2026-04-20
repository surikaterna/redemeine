import { MirageCoreSymbol, createMirage, type BuiltAggregate } from '@redemeine/mirage';
import {
  type ProjectionDefinition as RuntimeProjectionDefinition
} from '@redemeine/projection';
import type {
  IEventSubscription,
  IProjectionStore,
  IProjectionLinkStore
} from '@redemeine/projection-runtime-core';

type CommandEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown>;
};

type DomainEvent = {
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown>;
};

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

type ProjectionContext = {
  subscribeTo(aggregate: { aggregateType: string }, aggregateId: string): void;
  unsubscribeFrom(aggregate: { aggregateType: string }, aggregateId: string): void;
  getSubscriptions(): Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
};

type ProjectionDefinition<TState = unknown> = RuntimeProjectionDefinition<TState>;

type AggregateDefinitionLike = BuiltAggregate<any, any, any, any, any> & {
  readonly aggregateType?: string;
};

type SagaRegistrationLike = {
  readonly handlers?: ReadonlyArray<{
    readonly aggregateType?: string;
    readonly handlers: Record<string, unknown>;
  }>;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type EventQueueSubscription = IEventSubscription & {
  push(events: readonly ProjectionEvent[]): void;
  hasPendingEventsAfter(cursor: Checkpoint): boolean;
};

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

type ProjectionRuntimeModule = {
  core: ProjectionRuntimeCoreModule;
  inmemory: ProjectionRuntimeStoreInMemoryModule;
};

type ProjectionRuntime = {
  readonly projection: ProjectionDefinition<any>;
  readonly store: IProjectionStore<any>;
  readonly subscription: EventQueueSubscription;
  readonly daemon: ProjectionDaemonLike<any>;
};

let projectionRuntimeModulePromise: Promise<ProjectionRuntimeModule> | null = null;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadProjectionRuntimeModule(): Promise<ProjectionRuntimeModule> {
  if (!projectionRuntimeModulePromise) {
    projectionRuntimeModulePromise = (async () => {
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
    })();
  }

  return projectionRuntimeModulePromise;
}

export interface CreateTestDepotOptions {
  readonly aggregates: readonly AggregateDefinitionLike[];
  readonly sagas?: readonly SagaRegistrationLike[];
  readonly projections?: readonly ProjectionDefinition<any>[];
}

export interface TestDepot {
  dispatch(command: CommandEnvelope): Promise<void>;
  waitForIdle(): Promise<void>;
  projections: {
    get<TState>(projection: ProjectionDefinition<TState>, id: string): Promise<TState | null>;
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function getAggregateTypeFromDefinition(aggregate: AggregateDefinitionLike): string {
  return aggregate.aggregateType ?? 'unknown';
}

function resolveAggregateId(command: CommandEnvelope): string {
  const payload = command.payload;
  if (payload && typeof payload === 'object') {
    const id = (payload as Record<string, unknown>).id;
    if (id !== undefined) {
      return String(id);
    }
  }

  const metadataAggregateId = command.metadata?.aggregateId;
  if (metadataAggregateId !== undefined) {
    return String(metadataAggregateId);
  }

  return 'test-aggregate';
}

function createEventQueueSubscription(): EventQueueSubscription {
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
            sequence: events[events.length - 1].sequence,
            timestamp: events[events.length - 1].timestamp
          }
        : cursor;

      return {
        events,
        nextCursor
      };
    }
  };
}

function buildCommandRouting(aggregates: readonly AggregateDefinitionLike[]): Map<string, AggregateDefinitionLike> {
  const route = new Map<string, AggregateDefinitionLike>();
  for (const aggregate of aggregates) {
    for (const commandType of Object.keys(aggregate.pure.commandProcessors)) {
      route.set(commandType, aggregate);
    }
  }

  return route;
}

function toProjectionEvent(event: DomainEvent, aggregateId: string, sequence: number): ProjectionEvent {
  const aggregateType = event.type.includes('.') ? event.type.split('.')[0] : 'unknown';

  return {
    aggregateType,
    aggregateId,
    type: event.type,
    payload: (event.payload ?? {}) as Record<string, unknown>,
    sequence,
    timestamp: new Date().toISOString(),
    metadata: event.metadata
  };
}

export function createTestDepot(options: CreateTestDepotOptions): TestDepot {
  const commandRoute = buildCommandRouting(options.aggregates);

  // v1 hook only: sagas are registered for routing bookkeeping.
  // Full external worker response simulation is intentionally deferred.
  const sagaRegistrations = [...(options.sagas ?? [])];

  const projectionStoreByDefinition = new Map<ProjectionDefinition<any>, IProjectionStore<any>>();
  let projectionRuntimes: ProjectionRuntime[] = [];
  let projectionInitialization: Promise<void> | null = null;

  const ensureProjectionRuntimesInitialized = async (): Promise<void> => {
    if (!projectionInitialization) {
      projectionInitialization = (async () => {
        if ((options.projections ?? []).length === 0) {
          return;
        }

        const projectionRuntime = await loadProjectionRuntimeModule();
        projectionRuntimes = (options.projections ?? []).map((projection) => {
          const store = new projectionRuntime.inmemory.InMemoryProjectionStore<any>();
          const linkStore = new projectionRuntime.inmemory.InMemoryProjectionLinkStore();
          const subscription = createEventQueueSubscription();
          const daemon = new projectionRuntime.core.ProjectionDaemon({
            projection,
            subscription,
            store,
            batchSize: 100,
            linkStore
          });
          projectionStoreByDefinition.set(projection, store);

          return { projection, store, subscription, daemon };
        });
      })();
    }

    await projectionInitialization;
  };

  const mirages = new Map<string, ReturnType<typeof createMirage>>();
  const queue: Array<{ command: CommandEnvelope; deferred: Deferred<void> }> = [];
  let isProcessing = false;
  let activeDrain: Promise<void> | null = null;
  let globalSequence = 0;

  const processProjectionRuntimes = async (events: readonly DomainEvent[], aggregateId: string): Promise<void> => {
    await ensureProjectionRuntimesInitialized();

    if (events.length === 0 || projectionRuntimes.length === 0) {
      return;
    }

    const projectionEvents = events.map((event) => {
      globalSequence += 1;
      return toProjectionEvent(event, aggregateId, globalSequence);
    });

    for (const runtime of projectionRuntimes) {
      runtime.subscription.push(projectionEvents);
    }

    for (const runtime of projectionRuntimes) {
      while (true) {
        const cursor = (await runtime.store.getCheckpoint?.(`__cursor__${runtime.projection.name}`)) ?? { sequence: 0 };
        if (!runtime.subscription.hasPendingEventsAfter(cursor)) {
          break;
        }

        const stats = await runtime.daemon.processBatch();
        if (stats.eventsProcessed === 0) {
          break;
        }
      }
    }
  };

  const routeEventsToSagas = (_events: readonly DomainEvent[]): void => {
    // Hook-only routing pass for v1: this confirms registration and match lookup paths
    // without simulating external worker responses.
    for (const saga of sagaRegistrations) {
      const handlers = saga.handlers ?? [];
      void handlers;
    }
  };

  const resolveAggregateForCommand = (command: CommandEnvelope): AggregateDefinitionLike | undefined => {
    const direct = commandRoute.get(command.type);
    if (direct) {
      return direct;
    }

    const aggregatePrefix = command.type.split('.')[0];
    return options.aggregates.find((candidate) => getAggregateTypeFromDefinition(candidate) === aggregatePrefix);
  };

  const getOrCreateMirage = (aggregate: AggregateDefinitionLike, aggregateId: string) => {
    const key = `${getAggregateTypeFromDefinition(aggregate)}::${aggregateId}`;
    const existing = mirages.get(key);
    if (existing) {
      return existing;
    }

    const mirage = createMirage(aggregate, aggregateId);
    mirages.set(key, mirage);
    return mirage;
  };

  const processSingleCommand = async (command: CommandEnvelope): Promise<void> => {
    const aggregate = resolveAggregateForCommand(command);
    if (!aggregate) {
      throw new Error(`createTestDepot.dispatch: no aggregate registered for command type "${command.type}"`);
    }

    const aggregateId = resolveAggregateId(command);
    const mirage = getOrCreateMirage(aggregate, aggregateId);

    await Promise.resolve(mirage.dispatch(command));

    const core = (mirage as any)[MirageCoreSymbol] as {
      getPendingResults(): { events: DomainEvent[] };
      clearPendingResults(): void;
    };

    const pending = core.getPendingResults();
    core.clearPendingResults();

    routeEventsToSagas(pending.events);
    await processProjectionRuntimes(pending.events, aggregateId);
  };

  const runQueue = async (): Promise<void> => {
    if (isProcessing) {
      return;
    }

    isProcessing = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          continue;
        }

        try {
          await processSingleCommand(next.command);
          next.deferred.resolve(undefined);
        } catch (error) {
          next.deferred.reject(error);
        }
      }
    } finally {
      isProcessing = false;
      activeDrain = null;
    }
  };

  const ensureDrainStarted = (): Promise<void> => {
    if (!activeDrain) {
      activeDrain = runQueue();
    }

    return activeDrain;
  };

  return {
    async dispatch(command): Promise<void> {
      const deferred = createDeferred<void>();
      queue.push({ command, deferred });
      void ensureDrainStarted();
      await deferred.promise;
    },
    async waitForIdle(): Promise<void> {
      while (true) {
        const drain = activeDrain;
        if (!drain && queue.length === 0 && !isProcessing) {
          return;
        }

        if (drain) {
          await drain;
          continue;
        }

        await Promise.resolve();
      }
    },
    projections: {
      async get(projection, id) {
        await ensureProjectionRuntimesInitialized();

        const store = projectionStoreByDefinition.get(projection);
        if (!store) {
          throw new Error(`createTestDepot.projections.get: projection "${projection.name}" is not registered`);
        }

        return store.load(id);
      }
    }
  };
}
