import type { Queue } from './Queue';

export interface Command<Payload extends object = object> {
  type: string;
  payload: Payload;
  id?: string;
  aggregateType?: string;
  aggregateId?: string;
}

export interface Event<Payload extends object = object> {
  type: string;
  payload: Payload;
  id?: string;
  aggregateId?: string;
  correlationId?: string | undefined;
}

export interface CommandSink<S extends object = object> {
  sink(command: Command, aggregate: CompatibleAggregate<S>): Promise<CompatibleAggregate<S>>;
}

export interface CommandHandler<S extends object = object> {
  handle(aggregate: CompatibleAggregate<S>, command: Command): CompatibleAggregate<S>;
}

export interface EventHandler<S extends object = object> {
  handle(aggregate: CompatibleAggregate<S>, event: Event): void;
}

export interface CompatibleAggregate<S extends object = object> {
  id: string;
  type?: string;
  _state: S;
  _version: number;
  _uncommittedEvents: Event[];
  _commandQueue: Queue;
  _commandSink: CommandSink<S>;
  _eventHandler: EventHandler;
  _commandHandler: CommandHandler;
  _apply(event: Event, isNew?: boolean): CompatibleAggregate<S>;
  _process(command: Command): Promise<CompatibleAggregate<S>>;
  _sink(command: Command | Promise<Command>): Promise<CompatibleAggregate<S> | true>;
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
export type CompatibleAggregateConstructor<S extends object = object> = new (
  commandSink?: CommandSink<S> | null,
  eventHandler?: EventHandler | null,
  commandHandler?: CommandHandler | null,
) => CompatibleAggregate<S>;
