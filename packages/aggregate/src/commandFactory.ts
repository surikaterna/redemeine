import type { CommandContext, CommandIntents, PluginExtensions, ReadonlyDeep } from '@redemeine/kernel';
import { createCommandContextProxy } from './proxies/createCommandContextProxy';
import type { PackedCommandWithMeta, ShorthandCommandWithMeta } from './types/aggregateTyping';
import type { Event, CommandResult } from '@redemeine/kernel';

export type GenericSelectors = Record<string, unknown>;
// SAFETY: `any` required — GenericCommandMap must accept commands with any state type (contravariant)
export type GenericCommandMap = Record<string, RedemeineCommandDefinition<any, Record<string, unknown>, {}>>;
export type GenericCommandFactoryContext<TCommands extends Record<string, unknown> = Record<string, unknown>> = {
  selectors: GenericSelectors;
  commands?: CommandContext<CommandIntents<TCommands>>;
  plugins?: Record<string, unknown>;
};
export type GenericCommandFactory = (emit: unknown, context: GenericCommandFactoryContext) => GenericCommandMap;

export type RedemeineShorthandCommand<S, Args extends unknown[] = unknown[], TPlugins extends PluginExtensions = {}> = (
  state: ReadonlyDeep<S>,
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

export function composeCommandFactories(
  factories: GenericCommandFactory[]
): GenericCommandFactory {
  return (emit: unknown, context: GenericCommandFactoryContext) => {
    const resolvedContext = resolveCommandFactoryContext(context);
    const merged: GenericCommandMap = {};
    for (const factory of factories) {
      Object.assign(merged, factory(emit, resolvedContext));
    }
    return merged;
  };
}

export function resolveCommandHandler<S>(
  commandDef: RedemeineCommandDefinition<S>
): (state: ReadonlyDeep<S>, payload: unknown) => Event<unknown, string> | CommandResult<Event<unknown, string>, {}> {
  const handler = typeof commandDef === 'function'
    ? commandDef
    : commandDef.handler;

  return handler as (
    state: ReadonlyDeep<S>,
    payload: unknown
  ) => Event<unknown, string> | CommandResult<Event<unknown, string>, {}>;
}

export function createCommandPayload<S>(commandDef: RedemeineCommandDefinition<S>, args: unknown[]): unknown {
  if (typeof commandDef !== 'function' && 'pack' in commandDef && typeof commandDef.pack === 'function') {
    return commandDef.pack(...args);
  }
  return args[0];
}
