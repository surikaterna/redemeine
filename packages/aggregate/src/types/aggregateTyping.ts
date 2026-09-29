import type { CommandResult, Event, EventType, PluginExtensions, ReadonlyDeep } from '@redemeine/kernel';

// SAFETY: `any` in ReplaceFirstArg required for conditional type inference on arbitrary function shapes
type ReplaceFirstArg<S, F> = F extends (x: any, ...args: infer P) => infer R ? (state: S, ...args: P) => R : never;

type SnakeCase<S extends string, Previous extends string = ''> = S extends `${infer First}${infer Rest}`
  ? `${First extends Uppercase<First>
      ? Previous extends Lowercase<Previous>
        ? Previous extends Uppercase<Previous>
          ? Previous extends `${number}`
            ? '_'
            : ''
          : '_'
        : ''
      : ''}${Lowercase<First>}${SnakeCase<Rest, First>}`
  : S;

/** Resolves default flat snake_case event names, unless an explicit literal override is provided. */
export type ResolveEventName<AggregateName extends string, K, EOverrides> = K extends keyof EOverrides
  ? EOverrides[K] extends EventType
    ? EOverrides[K]
    : `${AggregateName}.${SnakeCase<Extract<K, string>>}.event`
  : `${AggregateName}.${SnakeCase<Extract<K, string>>}.event`;

/**
 * SMART EMITTER FACTORY
 * Checks the number of arguments in the event projector function to statically enforce payload parameters inside Command processors.
 * SAFETY: `any` throughout this type is required for conditional inference on event projector function shapes.
 */
export type EventEmitterFactory<AggregateName extends string, E, EOverrides> = {
  [K in keyof E]: E[K] extends (...args: any[]) => any
    ? Parameters<E[K]>['length'] extends 0 | 1
      ? (...args: [...ids: (string | number)[]]) => Event<void, string>
      : E[K] extends (state: any, event: Event<infer P, string>) => void
        ? [P] extends [void] | [undefined]
          ? (...args: [...ids: (string | number)[]]) => Event<void, string>
          : (...args: [...ids: (string | number)[], payload: P]) => Event<P, string>
        : (...args: [...ids: (string | number)[], payload: unknown]) => Event<unknown, string>
    : never;
} & Record<string, (...args: unknown[]) => Event<unknown, string>>;

// SAFETY: `any[]` in Args required for variadic command argument inference
export type PackedCommand<S, Args extends any[], P, TPlugins extends PluginExtensions = {}> = {
  /**
   * Defines the public API signature and serializable Command payload structure.
   */
  pack: (...args: Args) => P;
  handler: (state: ReadonlyDeep<S>, payload: P) => Event<unknown, string> | CommandResult<Event<unknown, string>, TPlugins>;
};

export type PackedCommandWithMeta<S, Args extends any[], P, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> =
  PackedCommand<S, Args, P, TPlugins> & {
    meta?: TMeta;
  };

// SAFETY: `any[]` in Args required for variadic command argument inference
export type ShorthandCommandWithMeta<S, Args extends any[] = any[], TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> = {
  handler: (state: ReadonlyDeep<S>, ...args: Args) => Event<unknown, string> | CommandResult<Event<unknown, string>, TPlugins>;
  meta?: TMeta;
};

// SAFETY: `any` in conditional extends below required for TypeScript `infer` to extract from arbitrary function/object shapes
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
