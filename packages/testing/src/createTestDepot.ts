import { produce } from 'immer';
import { MirageCoreSymbol, createMirage, type BuiltAggregate } from '@redemeine/mirage';

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
    readonly handlers: Record<string, (state: TState, event: ProjectionEvent, context: ProjectionContext) => void>;
  };
  readonly joinStreams?: readonly {
    readonly aggregate: { __aggregateType: string };
    readonly handlers: Record<string, (state: TState, event: ProjectionEvent, context: ProjectionContext) => void>;
  }[];
  readonly initialState: (documentId: string) => TState;
  readonly identity: (event: ProjectionEvent) => string | readonly string[];
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

type ProjectionRuntime = {
  readonly projection: ProjectionDefinition<any>;
  readonly documents: Map<string, any>;
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

function getHandlerCandidateKeys(event: ProjectionEvent): string[] {
  const keys = new Set<string>();
  const eventType = event.type;
  const aggregatePrefix = `${event.aggregateType}.`;
  const hasAggregatePrefix = eventType.startsWith(aggregatePrefix);
  const hasEventSuffix = eventType.endsWith('.event');

  keys.add(eventType);

  if (hasAggregatePrefix) {
    keys.add(eventType.slice(aggregatePrefix.length));
  }

  if (hasEventSuffix) {
    const withoutEventSuffix = eventType.slice(0, -'.event'.length);
    keys.add(withoutEventSuffix);

    if (withoutEventSuffix.startsWith(aggregatePrefix)) {
      keys.add(withoutEventSuffix.slice(aggregatePrefix.length));
    }
  }

  return Array.from(keys);
}

function createProjectionContext(): ProjectionContext {
  const subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];

  return {
    subscribeTo(aggregate, aggregateId) {
      subscriptions.push({ aggregate, aggregateId });
    },
    getSubscriptions() {
      return [...subscriptions];
    }
  };
}

function findHandler<TState>(
  projection: ProjectionDefinition<TState>,
  event: ProjectionEvent
): ((state: TState, event: ProjectionEvent, context: ProjectionContext) => void) | null {
  const resolve = (
    handlers: Record<string, (state: TState, event: ProjectionEvent, context: ProjectionContext) => void>
  ): ((state: TState, event: ProjectionEvent, context: ProjectionContext) => void) | null => {
    for (const key of getHandlerCandidateKeys(event)) {
      const handler = handlers[key];
      if (handler) {
        return handler;
      }
    }

    return null;
  };

  if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
    return resolve(projection.fromStream.handlers as Record<string, (state: TState, event: ProjectionEvent, context: ProjectionContext) => void>);
  }

  for (const joinStream of projection.joinStreams ?? []) {
    if (event.aggregateType === joinStream.aggregate.__aggregateType) {
      return resolve(joinStream.handlers as Record<string, (state: TState, event: ProjectionEvent, context: ProjectionContext) => void>);
    }
  }

  return null;
}

export function createTestDepot(options: CreateTestDepotOptions): TestDepot {
  const commandRoute = buildCommandRouting(options.aggregates);

  // v1 hook only: sagas are registered for routing bookkeeping.
  const sagaRegistrations = [...(options.sagas ?? [])];
  void sagaRegistrations;

  const projectionRuntimeByDefinition = new Map<ProjectionDefinition<any>, ProjectionRuntime>();
  for (const projection of options.projections ?? []) {
    projectionRuntimeByDefinition.set(projection, {
      projection,
      documents: new Map<string, any>()
    });
  }

  const mirages = new Map<string, ReturnType<typeof createMirage>>();
  const queue: Array<{ command: CommandEnvelope; deferred: Deferred<void> }> = [];
  let isProcessing = false;
  let activeDrain: Promise<void> | null = null;
  let globalSequence = 0;

  const processProjectionRuntimes = async (events: readonly DomainEvent[], aggregateId: string): Promise<void> => {
    if (events.length === 0 || projectionRuntimeByDefinition.size === 0) {
      return;
    }

    const projectionEvents = events.map((event) => {
      globalSequence += 1;
      return toProjectionEvent(event, aggregateId, globalSequence);
    });

    for (const runtime of projectionRuntimeByDefinition.values()) {
      for (const projectionEvent of projectionEvents) {
        const handler = findHandler(runtime.projection, projectionEvent);
        if (!handler) {
          continue;
        }

        const rawIdentity = runtime.projection.identity(projectionEvent);
        const identities = Array.isArray(rawIdentity) ? rawIdentity : [rawIdentity];
        const uniqueIdentities = [...new Set(identities.map((value) => String(value)))];

        for (const docId of uniqueIdentities) {
          const currentState = runtime.documents.get(docId) ?? runtime.projection.initialState(docId);
          const context = createProjectionContext();
          const nextState = produce(currentState, (draft) => {
            handler(draft, projectionEvent, context);
          });
          runtime.documents.set(docId, nextState);
        }
      }
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
        const runtime = projectionRuntimeByDefinition.get(projection);
        if (!runtime) {
          throw new Error(`createTestDepot.projections.get: projection "${projection.name}" is not registered`);
        }

        return runtime.documents.get(id) ?? null;
      }
    }
  };
}
