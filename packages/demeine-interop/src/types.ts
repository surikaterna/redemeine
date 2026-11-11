import type { Command, Event } from '@redemeine/kernel';
import type { CommandSinkInput, CommandHandlerInput, CompatibleAggregate, EventHandlerInput, ObjectCommandHandler } from './lifecycleTypes';

export type BridgeCommand = Command<unknown, string> & { aggregateId?: string; aggregateType?: string };
export type BridgeEvent = Event & { aggregateId: string; correlationId: string };

export type CommandCreators = Record<string, (...args: never) => BridgeCommand>;

export interface BridgeableAggregate<S extends object, C extends CommandCreators, Registry = unknown> {
  readonly __registryType?: Registry;
  mounts?: Record<string, { kind: string; semanticName?: string | undefined; commandPrefix: string; statePath: string[]; commandNames?: readonly string[] | undefined }>;
  initialState: S;
  aggregateType: string;
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
export type BridgeArguments<C extends (...args: never) => unknown> =
  Parameters<C> extends [] ? [payload?: Record<string, never>]
    : Parameters<C> extends [infer Payload]
      ? [Payload] extends [object]
        ? {} extends Payload ? [payload?: Payload] : Parameters<C>
        : Parameters<C>
      : Parameters<C>;

type BridgeInstance<S extends object, C extends CommandCreators> = CompatibleAggregate<S> & {
  [K in keyof C]: (...args: BridgeArguments<C[K]>) => ReturnType<CompatibleAggregate<S>['_sink']>;
};

export type BridgeConstructor<S extends object, C extends CommandCreators, Registry = {}> = {
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: CommandHandlerInput<S> | null): BridgeInstance<S, C> & RootAliases<S, C, Registry>;
  new (commandSink?: CommandSinkInput<S> | null, eventHandler?: EventHandlerInput<S> | null, commandHandler?: ObjectCommandHandler | null): BridgeInstance<S, C> & RootAliases<S, C, Registry>;
};

type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never;
type AliasEntries<C, R> = {
  [Mount in keyof R & string]: R[Mount] extends { kind: 'list'; semanticName: infer N extends string; entity: { commands: infer Commands } }
    ? string extends N ? never : true extends IsUnion<N> ? never : {
        [Key in keyof Commands & string]: Commands[Key] extends { readonly __staticCommand: true }
          ? Commands[Key] extends { readonly __nestedCommand: true } ? never
            : `${Mount}${Capitalize<Key>}` extends keyof C ? { name: `${Key}${Capitalize<N>}`; key: `${Mount}${Capitalize<Key>}` } : never
          : never
      }[keyof Commands & string] : never
}[keyof R & string];
type RootAliases<S extends object, C extends CommandCreators, R> = {
  [Entry in AliasEntries<C, R> as Entry['name']]: Entry['key'] extends keyof C
    ? (...args: BridgeArguments<C[Entry['key']]>) => ReturnType<CompatibleAggregate<S>['_sink']> : never;
};
