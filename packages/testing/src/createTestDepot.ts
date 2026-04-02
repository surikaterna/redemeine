import { MirageCoreSymbol, createMirage, type BuiltAggregate } from '@redemeine/mirage';

declare const require: (id: string) => unknown;

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
  subscribeTo(aggregate: { __aggregateType: string }, aggregateId: string): void;
  getSubscriptions(): Array<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
};

type ProjectionDefinition<TState = unknown> = {
  readonly name: string;
  readonly fromStream: {
    readonly aggregate: { __aggregateType: string };
    readonly handlers: Record<string, (state: TState, event: ProjectionEvent, ctx: ProjectionContext) => void>;
  };
  readonly joinStreams?: ReadonlyArray<{
    readonly aggregate: { __aggregateType: string };
    readonly handlers: Record<string, (state: TState, event: ProjectionEvent, ctx: ProjectionContext) => void>;
  }>;
  readonly initialState: (documentId: string) => TState;
  readonly identity: (event: ProjectionEvent) => string | readonly string[];
  readonly subscriptions: ReadonlyArray<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
};

type IEventSubscription = {
  poll(cursor: Checkpoint, batchSize: number): Promise<{ events: ProjectionEvent[]; nextCursor: Checkpoint }>;
};

type ProjectionStoreLike<TState> = {
  load(id: string): Promise<TState | null>;
  save(id: string, state: TState, cursor: Checkpoint): Promise<void>;
  getCheckpoint?(id: string): Promise<Checkpoint | null>;
};

type ProjectionDaemonLike = {
  processBatch(): Promise<{ eventsProcessed: number }>;
};

type ProjectionRuntimeModule = {
  InMemoryProjectionStore: new <TState = unknown>() => ProjectionStoreLike<TState>;
  ProjectionDaemon: new <TState = unknown>(options: {
    projection: ProjectionDefinition<TState>;
    subscription: IEventSubscription;
    store: ProjectionStoreLike<TState>;
    batchSize?: number;
  }) => ProjectionDaemonLike;
};

type AggregateDefinitionLike = BuiltAggregate<any, any, any, any, any> & {
  readonly __aggregateType?: string;
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

type ProjectionRuntime = {
  readonly projection: ProjectionDefinition<any>;
  readonly store: ProjectionStoreLike<any>;
  readonly subscription: EventQueueSubscription;
  readonly daemon: ProjectionDaemonLike;
};

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
  return aggregate.__aggregateType ?? 'unknown';
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
  const projectionRuntimeModule = require('../../projection/src') as ProjectionRuntimeModule;
  const commandRoute = buildCommandRouting(options.aggregates);

  // v1 hook only: sagas are registered for routing bookkeeping.
  // Full external worker response simulation is intentionally deferred.
  const sagaRegistrations = [...(options.sagas ?? [])];

  const projectionStoreByDefinition = new Map<ProjectionDefinition<any>, ProjectionStoreLike<any>>();
  const projectionRuntimes: ProjectionRuntime[] = (options.projections ?? []).map((projection) => {
    const store = new projectionRuntimeModule.InMemoryProjectionStore<any>();
    const subscription = createEventQueueSubscription();
    const daemon = new projectionRuntimeModule.ProjectionDaemon({ projection, subscription, store, batchSize: 100 });
    projectionStoreByDefinition.set(projection, store);

    return { projection, store, subscription, daemon };
  });

  const mirages = new Map<string, ReturnType<typeof createMirage>>();
  const queue: Array<{ command: CommandEnvelope; deferred: Deferred<void> }> = [];
  let isProcessing = false;
  let activeDrain: Promise<void> | null = null;
  let globalSequence = 0;

  const processProjectionRuntimes = async (events: readonly DomainEvent[], aggregateId: string): Promise<void> => {
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
        const store = projectionStoreByDefinition.get(projection);
        if (!store) {
          throw new Error(`createTestDepot.projections.get: projection "${projection.name}" is not registered`);
        }

        return store.load(id);
      }
    }
  };
}
