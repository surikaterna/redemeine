import { CommandResult, Event, PackedCommandWithMeta, PluginExtensions, SelectorsMap, ShorthandCommandWithMeta } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import type { Merge } from './utils/types/Merge';
import type { AllKeys } from './utils/types/AllKeys';
import type { ReplaceFirstArg } from './utils/types/ReplaceFirstArg';

export type GenericSelectors = Record<string, unknown>;
export type GenericCommandMap = Record<string, RedemeineCommandDefinition<any, Record<string, unknown>, {}>>;
export type GenericCommandFactory = (emit: unknown, context: { selectors: GenericSelectors; plugins?: Record<string, unknown> }) => GenericCommandMap;

export type RedemeineEventProjector<S> = (state: S, event: Event<any, any>) => void;
export type RedemeineEventDefinition<S, TMeta extends Record<string, unknown> = Record<string, unknown>> =
  | RedemeineEventProjector<S>
  | {
      projector: RedemeineEventProjector<S>;
      meta?: TMeta;
    };

export type NormalizeEventDefinitions<T extends Record<string, RedemeineEventDefinition<any, any>>> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? T[K]
    : T[K] extends { projector: infer P }
      ? Extract<P, (...args: any[]) => any>
      : never;
};

export type RedemeineShorthandCommand<S, Args extends unknown[] = unknown[], TPlugins extends PluginExtensions = {}> = (
  state: ReadonlyDeep<S>,
  ...args: Args
) => Event<any, any> | CommandResult<Event<any, any>, TPlugins>;

export type RedemeineCommandDefinition<
  S,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPlugins extends PluginExtensions = {}
> =
  | RedemeineShorthandCommand<S, any[], TPlugins>
  | ShorthandCommandWithMeta<S, any[], TMeta, TPlugins>
  | PackedCommandWithMeta<S, any[], any, TMeta, TPlugins>;

export type RedemeineCommandMap<S, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> = Record<string, RedemeineCommandDefinition<S, TMeta, TPlugins>>;

export interface RedemeineComponent<
  S,
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

export type ComponentCommandUnion<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  T[number] extends RedemeineComponent<any, infer C, any, any, any> ? C : {};

export type MergeComponentCommands<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  Merge<ComponentCommandUnion<T>>;

export type MergeComponentCommandKeys<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  AllKeys<ComponentCommandUnion<T>>;

export type PublicCommandArgsFromDefinition<S, TDef> =
  TDef extends { pack: (...args: infer A) => unknown }
    ? A
    : ReplaceFirstArg<never, Extract<TDef, (state: ReadonlyDeep<S>, ...args: unknown[]) => unknown>> extends (
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
  return (emit: unknown, context: { selectors: GenericSelectors; plugins?: Record<string, unknown> }) => {
    const merged: GenericCommandMap = {};
    for (const factory of factories) {
      Object.assign(merged, factory(emit, context));
    }
    return merged;
  };
}

export function resolveCommandHandler<S>(
  commandDef: RedemeineCommandDefinition<S>
): (state: ReadonlyDeep<S>, payload: unknown) => Event<any, any> | CommandResult<Event<any, any>, {}> {
  const handler = typeof commandDef === 'function'
    ? commandDef
    : commandDef.handler;

  return handler as (
    state: ReadonlyDeep<S>,
    payload: unknown
  ) => Event<any, any> | CommandResult<Event<any, any>, {}>;
}

export function createCommandPayload<S>(commandDef: RedemeineCommandDefinition<S>, args: unknown[]): unknown {
  if (typeof commandDef !== 'function' && 'pack' in commandDef && typeof commandDef.pack === 'function') {
    return commandDef.pack(...args);
  }
  return args[0];
}

export interface ComponentBehaviorSnapshot<S> {
  events: Record<string, Function>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: SelectorsMap<S>;
  commandOverrides: Record<string, string>;
}

export interface InheritableComponentBehavior {
  events: Record<string, Function>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: Record<string, Function>;
  commandOverrides: Record<string, string>;
  commandsFactory: GenericCommandFactory;
}

export function createComponentBehaviorState<S>() {
  let events: Record<string, Function> = {};
  let eventMetadata: Record<string, Record<string, unknown> | undefined> = {};
  let eventOverrides: Record<string, string> = {};
  let selectors: SelectorsMap<S> = {};
  let commandOverrides: Record<string, string> = {};
  let commandFactories: GenericCommandFactory[] = [];

  return {
    addEvents(next: Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>) {
      const normalizedEvents: Record<string, Function> = {};
      const normalizedMeta: Record<string, Record<string, unknown> | undefined> = {};

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

    addSelectors(next: Record<string, Function>) {
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

type FluentUpdaterMap = Record<string, (...args: unknown[]) => void>;

export function bindFluentMethods<TBuilder extends Record<string, unknown>, TUpdaters extends FluentUpdaterMap>(
  builder: TBuilder,
  updaters: TUpdaters
): TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder } {
  const mutableBuilder = builder as Record<string, unknown>;

  Object.keys(updaters).forEach((key) => {
    const methodName = key as keyof TUpdaters;
    mutableBuilder[methodName as string] = (...args: unknown[]) => {
      updaters[methodName](...args);
      return builder;
    };
  });

  return builder as TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder };
}
