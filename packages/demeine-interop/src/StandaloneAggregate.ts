import Bluebird from 'bluebird';
import { v4 as uuid } from 'uuid';
import { Queue } from './Queue';
import type { Command, CommandHandler, CommandSink, CompatibleAggregate, Event, EventHandler } from './lifecycleTypes';

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

export class StandaloneAggregate<S extends object> implements CompatibleAggregate<S> {
  id = uuid();
  type?: string;
  _state: S;
  _version = 0;
  _uncommittedEvents: Event[] = [];
  _commandQueue = new Queue();
  _commandSink: CommandSink<S>;
  _eventHandler: EventHandler;
  _commandHandler: CommandHandler;

  constructor(state: S, sink: CommandSink<S> | null | undefined, events: EventHandler, commands: CommandHandler) {
    this._state = structuredClone(state);
    this._commandSink = sink ?? { sink: command => this._process(command) };
    this._eventHandler = events;
    this._commandHandler = commands;
  }

  _process(command: Command): Promise<CompatibleAggregate<S>> {
    return new Bluebird<CompatibleAggregate<S>>((resolve, reject) => {
      // Legacy handlers declare object state while _process promises the caller's S.
      try { resolve(this._commandHandler.handle(this, command) as CompatibleAggregate<S>); }
      catch (error) { reject(error); }
    }).error(error => {
      // Bluebird's operational-only handler is deliberately not a catch-all.
      console.error('Failed to process command', command, error);
      this.clearUncommittedEvents();
      throw error;
    });
  }

  _sink(commandToSink: Command | Promise<Command>): Promise<CompatibleAggregate<S> | true> {
    // Observe an already-started native promise while FIFO work delays consumption.
    // Its value/error is still consumed only by this command's queued task.
    if (commandToSink instanceof Promise) void commandToSink.catch(() => undefined);
    return this._commandQueue.queueCommand(() => Promise.resolve(commandToSink).then<CompatibleAggregate<S> | true>(command => {
      if (!command.id) {
        console.warn('No command id set, setting it automatically');
        command.id = uuid();
      }
      if (!command.type || !command.aggregateId || command.aggregateId !== this.id) {
        throw new Error(`command is missing data: ${JSON.stringify(command)}`);
      }
      if (this.type) command.aggregateType = this.type;
      const result: Promise<CompatibleAggregate<S>> | undefined = this._commandSink.sink(command, this);
      const then: unknown = result?.then;
      if (result && then) return result;
      console.warn('sinking command but not returning promise, commands status and chaining might not work as expected');
      return true;
    }));
  }

  _apply(event: Event, isNew?: boolean): CompatibleAggregate<S> {
    if (!event.id) event.id = uuid();
    if (!event.type || !event.aggregateId || event.aggregateId !== this.id) {
      throw new Error(`event is missing data: ${JSON.stringify(event)}`);
    }
    this._eventHandler.handle(this, event);
    if (this._version === -1) this._version = 0;
    this._version++;
    if (isNew) this._uncommittedEvents.push(event);
    return this;
  }

  async _rehydrate(events: Event[], version?: number, snapshot?: S): Promise<void> {
    if (snapshot) this._state = snapshot;
    for (let index = 0; index < events.length; index++) {
      this._apply(events[index]!, false);
      if (index % 100 === 0) await yieldToEventLoop();
    }
    this._version = version || this._version;
  }

  _getSnapshot(): S | undefined { return this._state; }

  delete(): Promise<CompatibleAggregate<S> | true> {
    return this._sink({ type: '$stream.delete.command', aggregateId: this.id, payload: {} });
  }

  processDelete(command: Command): CompatibleAggregate<S> {
    return this._apply({
      type: '$stream.deleted.event', aggregateId: this.id, correlationId: command.id,
      payload: { aggregateType: this.type },
    }, true);
  }

  applyDeleted(): void {}

  getVersion(): number { return this._version; }

  getUncommittedEvents<Payload extends object = object>(): Event<Payload>[] {
    if (this._commandQueue.isProcessing()) {
      throw new Error('Cannot get uncommitted events while there is still commands in queue - try using getUncommittedEventsAsync()');
    }
    // The historical generic accessor trusts the caller's payload schema, not a copy.
    return this._uncommittedEvents as Event<Payload>[];
  }

  getUncommittedEventsAsync<Payload extends object = object>(): Promise<Event<Payload>[]> {
    return this._commandQueue.empty().then(() => this._commandQueue.isProcessing()
      ? this.getUncommittedEventsAsync<Payload>() : this.getUncommittedEvents<Payload>());
  }

  clearUncommittedEvents(): Event[] {
    return (this._uncommittedEvents = []);
  }
}
