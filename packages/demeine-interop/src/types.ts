import type { Command, Event } from '@redemeine/kernel';
import type { CommandSink, CommandHandler, CompatibleAggregate, EventHandler, ObjectCommandHandler } from './lifecycleTypes';

export type BridgeCommand = Command<unknown, string> & { aggregateId?: string; aggregateType?: string };
export type BridgeEvent = Event & { aggregateId: string; correlationId: string };

export type CommandCreators = Record<string, (...args: never[]) => BridgeCommand>;

export interface BridgeableAggregate<S extends object, C extends CommandCreators> {
  initialState: S;
  aggregateType?: string;
  process(state: S, command: Command<unknown, string>): Event[];
  apply(state: S, event: Event<unknown, string>): S;
  types: { commands: Record<string, string>; events: Record<string, string> };
  commandCreators: C;
  hooks?: object;
  plugins?: readonly unknown[];
}

export type BridgeContext<S extends object> = CompatibleAggregate<S>;

export interface BridgeOptions<S extends object> {
  envelope?: (event: BridgeEvent, command: BridgeCommand, aggregate: BridgeContext<S>) => BridgeEvent;
}

type BridgeInstance<S extends object, C extends CommandCreators> = CompatibleAggregate<S> & {
  [K in keyof C]: (...args: Parameters<C[K]>) => ReturnType<CompatibleAggregate<S>['_sink']>;
};

export type BridgeConstructor<S extends object, C extends CommandCreators> = {
  new (commandSink?: CommandSink<S> | null, eventHandler?: EventHandler<S> | null, commandHandler?: CommandHandler<S> | null): BridgeInstance<S, C>;
  new (commandSink?: CommandSink<S> | null, eventHandler?: EventHandler<S> | null, commandHandler?: ObjectCommandHandler | null): BridgeInstance<S, C>;
};
