import type { CommandResult, Event, EventType, PluginExtensions, ReadonlyDeep } from '@redemeine/kernel';

type ReplaceFirstArg<S, F> = F extends (x: any, ...args: infer P) => infer R ? (state: S, ...args: P) => R : never;

/**
 * Resolves the final event name string during type inference.
 * Accounts for whether the targeted naming engine is utilized or if an explicit override was historically provided.
 */
export type ResolveEventName<AggregateName extends string, K, EOverrides> =
  K extends keyof EOverrides
    ? (EOverrides[K] extends EventType ? EOverrides[K] : `${AggregateName}.${Extract<K, string>}.event`)
    : `${AggregateName}.${Extract<K, string>}.event`;

/**
 * SMART EMITTER FACTORY
 * Checks the number of arguments in the event projector function to statically enforce payload parameters inside Command processors.
 */
export type EventEmitterFactory<AggregateName extends string, E, EOverrides> = {
  [K in keyof E]: E[K] extends (...args: any[]) => any
    ? Parameters<E[K]>['length'] extends 0 | 1
      ? (...args: [...ids: (string | number)[]]) => Event<void, any>
      : E[K] extends (state: any, event: Event<infer P, any>) => void
        ? [P] extends [void] | [undefined]
          ? (...args: [...ids: (string | number)[]]) => Event<void, any>
          : (...args: [...ids: (string | number)[], payload: P]) => Event<P, any>
        : (...args: [...ids: (string | number)[], payload: any]) => Event<any, any>
    : never;
} & Record<string, (...args: any[]) => Event<any, any>>;

export type PackedCommand<S, Args extends any[], P, TPlugins extends PluginExtensions = {}> = {
  /**
   * Defines the public API signature and serializable Command payload structure.
   */
  pack: (...args: Args) => P;
  handler: (state: ReadonlyDeep<S>, payload: P) => Event<any, any> | CommandResult<Event<any, any>, TPlugins>;
};

export type PackedCommandWithMeta<S, Args extends any[], P, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> =
  PackedCommand<S, Args, P, TPlugins> & {
    meta?: TMeta;
  };

export type ShorthandCommandWithMeta<S, Args extends any[] = any[], TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> = {
  handler: (state: ReadonlyDeep<S>, ...args: Args) => Event<any, any> | CommandResult<Event<any, any>, TPlugins>;
  meta?: TMeta;
};

type PublicArgsFromShorthand<T> = ReplaceFirstArg<never, T> extends (state: never, ...args: infer Args) => any
  ? Args
  : never;

export type MapCommandsToPayloads<C> = {
  [K in keyof C]: C[K] extends PackedCommand<any, infer Args, infer P>
    ? { args: Args, payload: P }
    : C[K] extends { handler: (state: any, ...args: any[]) => any }
      ? PublicArgsFromShorthand<C[K]['handler']> extends infer Args
        ? {
            args: Args;
            payload: Args extends [infer Single]
              ? Single
              : Args extends []
                ? void
                : Args;
          }
        : never
    : C[K] extends (state: any, ...args: any[]) => any
      ? PublicArgsFromShorthand<C[K]> extends infer Args
        ? {
            args: Args;
            payload: Args extends [infer Single]
              ? Single
              : Args extends []
                ? void
                : Args;
          }
        : never
      : never;
};
