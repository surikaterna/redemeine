import { Event, PackedCommand, SelectorsMap } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import type { Merge } from './utils/types/Merge';
import type { AllKeys } from './utils/types/AllKeys';
import type { ReplaceFirstArg } from './utils/types/ReplaceFirstArg';

export type RedemeineShorthandCommand<S, Args extends any[] = any[]> = (
  state: ReadonlyDeep<S>,
  ...args: Args
) => Event<any, any> | Event<any, any>[];

export type RedemeineCommandDefinition<S> =
  | RedemeineShorthandCommand<S, any[]>
  | PackedCommand<S, any[], any>;

export type RedemeineCommandMap<S> = Record<string, RedemeineCommandDefinition<S>>;

export interface RedemeineComponent<
  S,
  Commands extends Record<string, any> = {},
  Events extends Record<string, any> = {},
  Projectors extends Record<string, any> = {},
  Selectors extends Record<string, any> = {},
  EventOverrides extends object = Record<string, string>,
  CommandOverrides extends object = Record<string, string>
> {
  readonly state?: ReadonlyDeep<any>;
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
  TDef extends { pack: (...args: infer A) => any }
    ? A
    : ReplaceFirstArg<never, Extract<TDef, (state: ReadonlyDeep<S>, ...args: any[]) => any>> extends (
        state: never,
        ...args: infer A
      ) => any
      ? A
      : never;

export type PublicCommandMethodsFromInternal<S, TCommands extends Record<string, any>, TResult> = {
  [K in keyof TCommands]: (...args: PublicCommandArgsFromDefinition<S, TCommands[K]>) => TResult;
};

export function composeCommandFactories(
  factories: Array<(emit: any, context: any) => Record<string, any>>
): (emit: any, context: any) => Record<string, any> {
  return (emit: any, context: any) => {
    const merged: Record<string, any> = {};
    for (const factory of factories) {
      Object.assign(merged, factory(emit, context));
    }
    return merged;
  };
}

export function resolveCommandHandler<S>(
  commandDef: RedemeineCommandDefinition<S>
): (state: ReadonlyDeep<S>, payload: any) => Event<any, any> | Event<any, any>[] {
  return (typeof commandDef === 'function' ? commandDef : commandDef.handler) as (
    state: ReadonlyDeep<S>,
    payload: any
  ) => Event<any, any> | Event<any, any>[];
}

export function createCommandPayload<S>(commandDef: RedemeineCommandDefinition<S>, args: any[]): any {
  if (typeof commandDef !== 'function' && commandDef.pack) {
    return commandDef.pack(...args);
  }
  return args[0];
}

export interface ComponentBehaviorSnapshot<S> {
  events: Record<string, Function>;
  eventOverrides: Record<string, string>;
  selectors: SelectorsMap<S>;
  commandOverrides: Record<string, string>;
}

export interface InheritableComponentBehavior {
  events: Record<string, Function>;
  eventOverrides: Record<string, string>;
  selectors: Record<string, Function>;
  commandOverrides: Record<string, string>;
  commandsFactory: (emit: any, context: { selectors: any }) => Record<string, any>;
}

export function createComponentBehaviorState<S>() {
  let events: Record<string, Function> = {};
  let eventOverrides: Record<string, string> = {};
  let selectors: SelectorsMap<S> = {};
  let commandOverrides: Record<string, string> = {};
  let commandFactories: Array<(emit: any, context: { selectors: any }) => Record<string, any>> = [];

  return {
    addEvents(next: Record<string, Function>) {
      events = { ...events, ...next };
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

    addCommandsFactory(factory: (emit: any, context: { selectors: any }) => Record<string, any>) {
      commandFactories.push(factory);
    },

    inherit(parent: InheritableComponentBehavior) {
      events = { ...parent.events, ...events };
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
        eventOverrides,
        selectors,
        commandOverrides
      };
    }
  };
}
