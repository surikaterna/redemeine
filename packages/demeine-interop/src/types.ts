import type { Command, Event } from '@redemeine/kernel';

export type BridgeCommand = Command<unknown, string> & { aggregateId?: string; aggregateType?: string };
export type BridgeEvent = Event & { aggregateId: string; correlationId: string };

/** Only the lifecycle surface used by the adapter; the supplied base owns the rest. */
export interface LegacyAggregate {
  id: string;
  type?: string;
  _state: object;
  _apply(event: { type: string; payload: object; aggregateId?: string }, isNew?: boolean): unknown;
  _sink(command: { type: string; payload: object; aggregateId?: string }): Promise<unknown>;
  processDelete(command: { type: string; payload: object; id?: string }): unknown;
  applyDeleted(): void;
}

export type AggregateBase = new (...args: never[]) => LegacyAggregate;
export type CommandCreators = Record<string, (...args: never[]) => BridgeCommand>;

export interface BridgeableAggregate<S extends object, C extends CommandCreators> {
  initialState: S;
  aggregateType?: string;
  process(state: S, command: Command<unknown, string>): Event[];
  apply(state: S, event: Event): S;
  types: { commands: Record<string, string>; events: Record<string, string> };
  commandCreators: C;
  hooks?: object;
  plugins?: readonly unknown[];
}

export interface BridgeContext<S extends object> extends LegacyAggregate {
  _state: S;
}

export interface BridgeOptions<S extends object, B extends AggregateBase> {
  AggregateBase: B;
  envelope?: (event: BridgeEvent, command: BridgeCommand, aggregate: BridgeContext<S>) => BridgeEvent;
}

type Services<B extends AggregateBase> = ConstructorParameters<B>;
export type BridgeConstructor<S extends object, C extends CommandCreators, B extends AggregateBase> = new (
  commandSink?: Services<B>[0] | null,
  eventHandler?: Services<B>[1] | null,
  commandHandler?: Services<B>[2] | null,
) => InstanceType<B> & { _state: S } & {
  [K in keyof C]: (...args: Parameters<C[K]>) => ReturnType<InstanceType<B>['_sink']>;
};

export interface Dispatcher<S extends object, M> {
  handle(aggregate: BridgeContext<S>, message: M): unknown;
}
