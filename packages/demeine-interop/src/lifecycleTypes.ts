import type { Queue } from './Queue';

export interface Command<Payload extends object = object> {
  type: string;
  payload: Payload;
  id?: string;
  aggregateType?: string;
  aggregateId?: string;
  headers?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface Event<Payload extends object = object> {
  type: string;
  payload: Payload;
  id?: string;
  aggregateId?: string;
  correlationId?: string | undefined;
  headers?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CommandSink<S extends object = object> {
  sink(command: Command, aggregate: CompatibleAggregate<S>): Promise<CompatibleAggregate<S>>;
}

export interface CommandHandler<S extends object = object> {
  handle(aggregate: CompatibleAggregate<S>, command: Command): CompatibleAggregate<S>;
}

// A legacy fallback must genuinely accept object state, not erase a narrower handler.
export type ObjectCommandHandler = {
  handle: (aggregate: CompatibleAggregate, command: Command) => CompatibleAggregate;
};

export interface EventHandler<S extends object = object> {
  handle(aggregate: CompatibleAggregate<S>, event: Event): void;
}

// Constructor inputs must be contravariant, unlike legacy service methods.
export type CommandHandlerInput<S extends object> = {
  handle: (aggregate: CompatibleAggregate<S>, command: Command) => CompatibleAggregate<S>;
};

export type EventHandlerInput<S extends object> = {
  handle: (aggregate: CompatibleAggregate<S>, event: Event) => void;
};

export type CommandSinkInput<S extends object> = {
  sink: (command: Command, aggregate: CompatibleAggregate<S>) => Promise<CompatibleAggregate<S>>;
};

export interface CompatibleAggregate<S extends object = object> {
  id: string;
  type?: string;
  _state: S;
  _version: number;
  _uncommittedEvents: Event[];
  _commandQueue: Queue;
  _commandSink: CommandSink<S>;
  _eventHandler: EventHandler<S>;
  _commandHandler: CommandHandler<S> | ObjectCommandHandler;
  _apply(event: Event, isNew?: boolean): CompatibleAggregate<S>;
  _process(command: Command): Promise<CompatibleAggregate<S>>;
  _sink(command: Command | PromiseLike<Command>): Promise<CompatibleAggregate<S> | true>;
  _rehydrate(events: Event[], version?: number, snapshot?: S): Promise<void>;
  _getSnapshot(): S | undefined;
  delete(): Promise<CompatibleAggregate<S> | true>;
  processDelete(command: Command): CompatibleAggregate<S>;
  applyDeleted(): void;
  getVersion(): number;
  getUncommittedEvents<Payload extends object = object>(): Event<Payload>[];
  getUncommittedEventsAsync<Payload extends object = object>(): Promise<Event<Payload>[]>;
  clearUncommittedEvents(): Event[];
}

/** Annotate an authored subclass's base without introducing generated shortcuts. */
export type CompatibleAggregateConstructor<S extends object = object> = {
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: CommandHandlerInput<S> | null): CompatibleAggregate<S>;
  // Legacy handlers return object-state aggregates; retain that honest alternative.
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: ObjectCommandHandler | null): CompatibleAggregate<S>;
};
