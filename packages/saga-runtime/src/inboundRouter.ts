export interface SagaInboundCommand<TPayload = unknown, TType extends string = string> {
  readonly type: TType;
  readonly payload: TPayload;
}

export interface SagaInboundEvent<TPayload = unknown, TType extends string = string> {
  readonly type: TType;
  readonly payload: TPayload;
}

export interface SagaInboundAggregate<
  TState,
  TCommand extends SagaInboundCommand = SagaInboundCommand,
  TEvent extends SagaInboundEvent = SagaInboundEvent
> {
  readonly initialState: TState;
  process(state: TState, command: TCommand): TEvent[];
  apply(state: TState, event: TEvent): TState;
}

export interface SagaInboundRouteInput<TCommand extends SagaInboundCommand = SagaInboundCommand> {
  readonly sagaId: string;
  readonly command: TCommand;
}

export interface SagaInboundRouteResult<TState, TEvent extends SagaInboundEvent = SagaInboundEvent> {
  readonly sagaId: string;
  readonly state: TState;
  readonly events: readonly TEvent[];
  readonly inboundSequence: number;
  readonly sagaSequence: number;
}

export interface SagaInboundRouterOptions<
  TState,
  TCommand extends SagaInboundCommand = SagaInboundCommand,
  TEvent extends SagaInboundEvent = SagaInboundEvent
> {
  readonly aggregate: SagaInboundAggregate<TState, TCommand, TEvent>;
  readonly getSagaState?: (sagaId: string) => TState | undefined;
  readonly setSagaState?: (sagaId: string, state: TState) => void;
  readonly createInitialSagaState?: (sagaId: string) => TState;
  readonly resolveSingleFlightKey?: (input: SagaInboundRouteInput<TCommand>) => string;
  readonly beforeProcess?: (input: SagaInboundRouteInput<TCommand>) => Promise<void> | void;
}

/**
 * Deterministic inbound router with strict per-saga single-flight by default.
 *
 * - Commands for the same saga are serialized in arrival order.
 * - Commands for different sagas can run concurrently.
 * - Aggregate invariants are enforced by delegating command execution through
 *   the supplied aggregate `process/apply` pipeline.
 */
export class SagaInboundRouter<
  TState,
  TCommand extends SagaInboundCommand = SagaInboundCommand,
  TEvent extends SagaInboundEvent = SagaInboundEvent
> {
  private readonly aggregate: SagaInboundAggregate<TState, TCommand, TEvent>;

  private readonly stateBySaga = new Map<string, TState>();

  private readonly inFlightByKey = new Map<string, Promise<unknown>>();

  private readonly getSagaState?: (sagaId: string) => TState | undefined;

  private readonly setSagaState?: (sagaId: string, state: TState) => void;

  private readonly createInitialSagaState: (sagaId: string) => TState;

  private readonly resolveSingleFlightKey: (input: SagaInboundRouteInput<TCommand>) => string;

  private readonly beforeProcess?: (input: SagaInboundRouteInput<TCommand>) => Promise<void> | void;

  private inboundSequence = 0;

  private readonly sagaSequenceBySaga = new Map<string, number>();

  constructor(options: SagaInboundRouterOptions<TState, TCommand, TEvent>) {
    this.aggregate = options.aggregate;
    this.getSagaState = options.getSagaState;
    this.setSagaState = options.setSagaState;
    this.createInitialSagaState = options.createInitialSagaState ?? (() => this.aggregate.initialState);
    this.resolveSingleFlightKey = options.resolveSingleFlightKey ?? ((input) => input.sagaId);
    this.beforeProcess = options.beforeProcess;
  }

  getState(sagaId: string): TState | undefined {
    return this.stateBySaga.get(sagaId) ?? this.getSagaState?.(sagaId);
  }

  async route(input: SagaInboundRouteInput<TCommand>): Promise<SagaInboundRouteResult<TState, TEvent>> {
    const key = this.resolveSingleFlightKey(input);
    const previous = this.inFlightByKey.get(key) ?? Promise.resolve();

    const run = async (): Promise<SagaInboundRouteResult<TState, TEvent>> => {
      await this.beforeProcess?.(input);

      const currentState = this.getState(input.sagaId) ?? this.createInitialSagaState(input.sagaId);
      const events = this.aggregate.process(currentState, input.command);

      let nextState = currentState;
      for (const event of events) {
        nextState = this.aggregate.apply(nextState, event);
      }

      this.stateBySaga.set(input.sagaId, nextState);
      this.setSagaState?.(input.sagaId, nextState);

      this.inboundSequence += 1;
      const sagaSequence = (this.sagaSequenceBySaga.get(input.sagaId) ?? 0) + 1;
      this.sagaSequenceBySaga.set(input.sagaId, sagaSequence);

      return {
        sagaId: input.sagaId,
        state: nextState,
        events,
        inboundSequence: this.inboundSequence,
        sagaSequence
      };
    };

    const task = previous
      .catch(() => undefined)
      .then(run);

    const marker = task.then(() => undefined, () => undefined);
    this.inFlightByKey.set(key, marker);

    const clearIfCurrent = () => {
      if (this.inFlightByKey.get(key) === marker) {
        this.inFlightByKey.delete(key);
      }
    };

    task.then(clearIfCurrent, clearIfCurrent);

    return task;
  }
}

export function createSagaInboundRouter<
  TState,
  TCommand extends SagaInboundCommand = SagaInboundCommand,
  TEvent extends SagaInboundEvent = SagaInboundEvent
>(options: SagaInboundRouterOptions<TState, TCommand, TEvent>): SagaInboundRouter<TState, TCommand, TEvent> {
  return new SagaInboundRouter(options);
}
