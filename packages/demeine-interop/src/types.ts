import type { Command, Event } from '@redemeine/kernel';
import type { CommandSinkInput, CommandHandlerInput, CompatibleAggregate, EventHandlerInput, ObjectCommandHandler } from './lifecycleTypes';

export type BridgeCommand = Command<unknown, string> & { aggregateId?: string; aggregateType?: string };
export type BridgeEvent = Event & { aggregateId: string; correlationId: string };

export type CommandCreators = Record<string, (...args: never[]) => BridgeCommand>;

export interface BridgeableAggregate<S extends object, C extends CommandCreators> {
  initialState: S;
  aggregateType?: string;
  process(state: S, command: Command<unknown, string>): Event[];
  prepareCommand?(state: S, command: Command<unknown, string>): BridgeCommand;
  aggregatePlugins?: readonly { commandEnvelope?: unknown; eventEnvelope?: unknown }[];
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

/** Legacy shortcut arguments; only a single required, empty-compatible object may be omitted. */
export type BridgeArguments<C extends (...args: never[]) => unknown> =
  Parameters<C> extends [] ? [payload?: Record<string, never>]
    : Parameters<C> extends [infer Payload]
      ? [Payload] extends [object]
        ? {} extends Payload ? [payload?: Payload] : Parameters<C>
        : Parameters<C>
      : Parameters<C>;

type BridgeInstance<S extends object, C extends CommandCreators> = CompatibleAggregate<S> & {
  [K in keyof C]: (...args: BridgeArguments<C[K]>) => ReturnType<CompatibleAggregate<S>['_sink']>;
};

export type BridgeConstructor<S extends object, C extends CommandCreators> = {
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: CommandHandlerInput<S> | null): BridgeInstance<S, C>;
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: ObjectCommandHandler | null): BridgeInstance<S, C>;
};
