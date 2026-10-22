import type { CommandResult, Event, EventType, PluginExtensions } from '@redemeine/kernel';
import type { AggregateStateView } from './aggregateState';

// SAFETY: `any` in ReplaceFirstArg required for conditional type inference on arbitrary function shapes
type ReplaceFirstArg<S, F> = F extends (x: any, ...args: infer P) => infer R ? (state: S, ...args: P) => R : never;

type AsciiLowercase = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type AsciiDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

// Match naming.ts's ASCII boundary before lowercasing the result.
type SnakeCase<S extends string, Previous extends string = ''> = S extends `${infer First}${infer Rest}`
  ? `${First extends Uppercase<AsciiLowercase>
      ? Previous extends AsciiLowercase | AsciiDigit ? '_' : ''
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
  handler: (state: AggregateStateView<S>, payload: P) => Event<unknown, string> | CommandResult<Event<unknown, string>, TPlugins>;
};

export type PackedCommandWithMeta<S, Args extends any[], P, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> =
  PackedCommand<S, Args, P, TPlugins> & {
    meta?: TMeta;
  };

// SAFETY: `any[]` in Args required for variadic command argument inference
export type ShorthandCommandWithMeta<S, Args extends any[] = any[], TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> = {
  handler: (state: AggregateStateView<S>, ...args: Args) => Event<unknown, string> | CommandResult<Event<unknown, string>, TPlugins>;
  meta?: TMeta;
};

// SAFETY: `any` in conditional extends below required for TypeScript `infer` to extract from arbitrary function/object shapes
type PublicArgsFromShorthand<T> = ReplaceFirstArg<never, T> extends (state: never, ...args: infer Args) => any
  ? Args
  : never;

export type MapCommandsToPayloads<C> = {
  [K in keyof C]: C[K] extends (...args: never[]) => unknown
    ? PublicArgsFromShorthand<C[K]> extends infer Args
      ? {
          args: Args;
          payload: ShorthandPayload<Args>;
        }
      : never
    : C[K] extends PackedCommand<any, infer Args, infer P>
      ? { args: Args, payload: P }
      : C[K] extends { handler: (state: any, ...args: any[]) => any }
        ? PublicArgsFromShorthand<C[K]['handler']> extends infer Args
          ? {
              args: Args;
              payload: ShorthandPayload<Args>;
            }
          : never
        : never;
};

type ShorthandPayload<Args> = Args extends [] ? void : Args extends readonly unknown[] ? Args[0] : never;

// Runtime classifies callables first and forwards one payload; only object-form pack consumes multiple arguments.
type ValidCommandDefinition<T> = T extends (...args: never[]) => unknown
  ? PublicArgsFromShorthand<T>['length'] extends 0 | 1 ? T : never
  : T extends { pack: (...args: infer _Args) => unknown }
    ? T
    : T extends { handler: infer Handler }
      ? PublicArgsFromShorthand<Handler>['length'] extends 0 | 1 ? T : never
      : never;

export type ValidCommandDefinitions<C> = { [K in keyof C]: ValidCommandDefinition<C[K]> };
