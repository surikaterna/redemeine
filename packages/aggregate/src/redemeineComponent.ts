import { type CommandContext, type CommandIntents, type CommandResult, type Event, type PluginExtensions, type SelectorsMap, type ReadonlyDeep } from '@redemeine/kernel';
import { createCommandContextProxy } from './proxies/createCommandContextProxy';
import type { Merge } from './types/Merge';
import type { AllKeys } from './types/AllKeys';
import type { ReplaceFirstArg } from './types/ReplaceFirstArg';
import type { PackedCommandWithMeta, ShorthandCommandWithMeta } from './types/aggregateTyping';
import type { Draft } from 'immer';
import type { AggregateStateView } from './types/aggregateState';
import { mergeDefinitions } from './build/entityCommandTarget';

export type GenericSelectors = Record<string, unknown>;
// SAFETY: `any` required — GenericCommandMap must accept commands with any state type (contravariant)
export type GenericCommandMap = Record<string, RedemeineCommandDefinition<any, Record<string, unknown>, {}>>;
export type GenericCommandFactoryContext<TCommands extends Record<string, unknown> = Record<string, unknown>> = {
  selectors: GenericSelectors;
  commands?: CommandContext<CommandIntents<TCommands>>;
  plugins?: Record<string, unknown>;
};
export type GenericCommandFactory = (emit: unknown, context: GenericCommandFactoryContext) => GenericCommandMap;

export function resolveCommandFactoryContext(
  context: GenericCommandFactoryContext
): GenericCommandFactoryContext {
  if (context.commands) {
    return context;
  }

  return {
    ...context,
    commands: createCommandContextProxy<Record<string, unknown>>()
  };
}

// SAFETY: `any` in Event type params required — projectors accept events with heterogeneous payloads
export type RedemeineEventProjector<S> = (state: Draft<S>, event: Event<any, any>) => void;
export type RedemeineEventDefinition<S, TMeta extends Record<string, unknown> = Record<string, unknown>> =
  | RedemeineEventProjector<S>
  | {
      projector: RedemeineEventProjector<S>;
      meta?: TMeta;
    };

export type NormalizeEventDefinitions<T extends Record<string, RedemeineEventDefinition<any, any>>> = {
  // SAFETY: `any` in conditional extends clauses required for inference of arbitrary function shapes
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? T[K]
    : T[K] extends { projector: infer P }
      ? Extract<P, (...args: any[]) => any>
      : never;
};

// Keep replacement keys scoped when TypeScript emits inferred downstream declarations.
// SAFETY: `any` matches NormalizeEventDefinitions' existential projector constraint, not the inferred event map.
export type MergeEventDefinitions<Existing, Incoming extends Record<string, RedemeineEventDefinition<any, any>>> =
  Omit<Existing, keyof Incoming> & NormalizeEventDefinitions<Incoming>;

export type RedemeineShorthandCommand<S, Args extends unknown[] = unknown[], TPlugins extends PluginExtensions = {}> = (
  state: AggregateStateView<S>,
  ...args: Args
) => Event<unknown, string> | CommandResult<Event<unknown, string>, TPlugins>;

export type RedemeineCommandDefinition<
  S,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPlugins extends PluginExtensions = {}
> =
  // SAFETY: `any[]` in these positions required for contravariant argument matching in command definitions
  | RedemeineShorthandCommand<S, any[], TPlugins>
  | ShorthandCommandWithMeta<S, any[], TMeta, TPlugins>
  | PackedCommandWithMeta<S, any[], unknown, TMeta, TPlugins>;

export type RedemeineCommandMap<S, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> = Record<string, RedemeineCommandDefinition<S, TMeta, TPlugins>>;

export interface RedemeineComponent<
  S,
  // SAFETY: `any` in generic defaults required for structural subtyping of component unions
  Commands extends Record<string, any> = {},
  Events extends Record<string, any> = {},
  Projectors extends Record<string, any> = {},
  Selectors extends Record<string, any> = {},
  EventOverrides extends object = Record<string, string>,
  CommandOverrides extends object = Record<string, string>
> {
  /**
   * Phantom generic brand to enforce component state compatibility in structural typing.
   */
  readonly __stateType?: S;
  readonly state?: ReadonlyDeep<unknown>;
  readonly commands: Commands;
  readonly events: Events;
  readonly projectors: Projectors;
  readonly selectors: Selectors;
  readonly eventOverrides: EventOverrides;
  readonly commandOverrides: CommandOverrides;
}

// SAFETY: `any` in component type positions required for covariant union extraction
export type ComponentCommandUnion<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  T[number] extends RedemeineComponent<any, infer C, any, any, any> ? C : {};

export type MergeComponentCommands<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  Merge<ComponentCommandUnion<T>>;

export type MergeComponentCommandKeys<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  AllKeys<ComponentCommandUnion<T>>;

export type PublicCommandArgsFromDefinition<S, TDef> =
  TDef extends { pack: (...args: infer A) => unknown }
    ? A
    : ReplaceFirstArg<never, Extract<TDef, (state: AggregateStateView<S>, ...args: unknown[]) => unknown>> extends (
        state: never,
        ...args: infer A
      ) => unknown
      ? A
      : never;

export type PublicCommandMethodsFromInternal<S, TCommands extends Record<string, unknown>, TResult> = {
  [K in keyof TCommands]: (...args: PublicCommandArgsFromDefinition<S, TCommands[K]>) => TResult;
};

export function composeCommandFactories(
  factories: GenericCommandFactory[]
): GenericCommandFactory {
  const registrations = [...factories];
  return (emit: unknown, context: GenericCommandFactoryContext) => {
    const resolvedContext = resolveCommandFactoryContext(context);
    const merged: GenericCommandMap = Object.create(null);
    for (const factory of registrations) {
      mergeDefinitions(merged, factory(emit, resolvedContext));
    }
    return merged;
  };
}

export function resolveCommandHandler<S>(
  commandDef: RedemeineCommandDefinition<S>
): (state: AggregateStateView<S>, payload: unknown) => Event<unknown, string> | CommandResult<Event<unknown, string>, {}> {
  const handler = typeof commandDef === 'function'
    ? commandDef
    : commandDef.handler;

  return handler as (
    state: AggregateStateView<S>,
    payload: unknown
  ) => Event<unknown, string> | CommandResult<Event<unknown, string>, {}>;
}

// A non-enumerable carrier keeps the original receiver across ESM/CJS compilation.
// This is internal registration data, not a public command-definition method.
const packReceiver = Symbol.for('@redemeine/aggregate/compiled-pack-receiver/v1');
type WithPackReceiver = { readonly [packReceiver]: object };

export function getPackReceiver(definition: object): object {
  return Object.hasOwn(definition, packReceiver)
    ? (definition as WithPackReceiver)[packReceiver] : definition;
}

export function attachPackReceiver(snapshot: object, definition: object): void {
  Object.defineProperty(snapshot, packReceiver, { value: getPackReceiver(definition) });
}

export function createCommandPayload<S>(commandDef: RedemeineCommandDefinition<S>, args: unknown[]): unknown {
  if (typeof commandDef !== 'function' && 'pack' in commandDef && typeof commandDef.pack === 'function') {
    return Reflect.apply(commandDef.pack, getPackReceiver(commandDef), args);
  }
  return args[0];
}

// SAFETY: Using `Function` for event/selector storage because projectors have heterogeneous signatures
// that are incompatible with a single typed function signature due to contravariance.
export type AnyFunction = Function;

export interface ComponentBehaviorSnapshot<S> {
  events: Record<string, AnyFunction>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: SelectorsMap<S>;
  commandOverrides: Record<string, string>;
}

export interface InheritableComponentBehavior {
  events: Record<string, AnyFunction>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: Record<string, AnyFunction>;
  commandOverrides: Record<string, string>;
  commandsFactory: GenericCommandFactory;
}

export function createComponentBehaviorState<S>() {
  let events: Record<string, AnyFunction> = {};
  let eventMetadata: Record<string, Record<string, unknown> | undefined> = {};
  let eventOverrides: Record<string, string> = {};
  let selectors: SelectorsMap<S> = {};
  let commandOverrides: Record<string, string> = {};
  let commandFactories: GenericCommandFactory[] = [];

  return {
    addEvents(next: Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>) {
      const normalizedEvents: Record<string, AnyFunction> = Object.create(null);
      const normalizedMeta: Record<string, Record<string, unknown> | undefined> = Object.create(null);

      Object.keys(next).forEach((key) => {
        const definition = next[key];
        if (typeof definition === 'function') {
          normalizedEvents[key] = definition;
          return;
        }

        if (definition && typeof definition.projector === 'function') {
          normalizedEvents[key] = definition.projector;
          normalizedMeta[key] = definition.meta;
        }
      });

      events = { ...events, ...normalizedEvents };
      eventMetadata = { ...eventMetadata, ...normalizedMeta };
    },

    addEventOverrides(next: Record<string, string>) {
      eventOverrides = { ...eventOverrides, ...next };
    },

    addSelectors(next: Record<string, AnyFunction>) {
      selectors = { ...selectors, ...next } as SelectorsMap<S>;
    },

    addCommandOverrides(next: Record<string, string>) {
      commandOverrides = { ...commandOverrides, ...next };
    },

    addCommandsFactory(factory: GenericCommandFactory) {
      commandFactories.push(factory);
    },

    inherit(parent: InheritableComponentBehavior) {
      events = { ...parent.events, ...events };
      eventMetadata = { ...parent.eventMetadata, ...eventMetadata };
      eventOverrides = { ...parent.eventOverrides, ...eventOverrides };
      selectors = { ...(parent.selectors as SelectorsMap<S>), ...selectors };
      commandOverrides = { ...parent.commandOverrides, ...commandOverrides };
      commandFactories = [parent.commandsFactory, ...commandFactories];
    },

    getCommandsFactory() {
      return composeCommandFactories(commandFactories);
    },

    getSnapshot(): ComponentBehaviorSnapshot<S> {
      return {
        events,
        eventMetadata,
        eventOverrides,
        selectors,
        commandOverrides
      };
    }
  };
}

// SAFETY: `any` required for variadic argument forwarding in fluent builder pattern
type FluentUpdaterMap = Record<string, (...args: any[]) => void>;

export function bindFluentMethods<TBuilder extends Record<string, unknown>, TUpdaters extends FluentUpdaterMap>(
  builder: TBuilder,
  updaters: TUpdaters
): TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder } {
  const mutableBuilder = builder as Record<string, unknown>;

  Object.keys(updaters).forEach((key) => {
    const methodName = key as keyof TUpdaters;
    mutableBuilder[methodName as string] = (...args: unknown[]) => {
      updaters[methodName]!(...args);
      return builder;
    };
  });

  return builder as TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder };
}
