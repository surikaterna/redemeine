import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import type { ReplaceFirstArg } from './utils/types/ReplaceFirstArg';

// types.ts

/**
 * The foundational string type for Redemeine events. Used to enforce proper suffixing in type boundaries.
 */
export type EventType = `${string}.event`;

/**
 * The foundational string type for Redemeine commands. Used to enforce proper suffixing in type boundaries.
 */
export type CommandType = `${string}.command`;

export type EnvelopeHeaders = Record<string, unknown>;

/**
 * Interface controlling the "Targeted Naming" engine used to automatically route and identify events and commands.
 */
export interface NamingStrategy {
  /**
   * Transforms a given property name (and optionally its path) into a fully qualified command type string.
   * 
   * @example
   * // Given aggregate 'order' and prop 'cancelItem', standard output: 'order.cancel_item.command'
   */
  command: (aggregateName: string, prop: string, path?: string) => string;
  
  /**
   * Transforms a given property name (and optionally its path) into a fully qualified event type string.
   * 
   * @example
   * // Given aggregate 'order' and prop 'itemCancelled', standard output: 'order.item_cancelled.event'
   */
  event: (aggregateName: string, prop: string, path?: string) => string;
}

export interface AggregateHooks<State> {
  onBeforeCommand?: (command: CommandType | Command<any, any>, state: ReadonlyDeep<State>) => void;
  onAfterCommand?: (command: CommandType | Command<any, any>, events: Event<any, any>[], state: ReadonlyDeep<State>) => void;
  onEventApplied?: (event: Event<any, any>, state: ReadonlyDeep<State>) => void;
}

export interface CommandInterceptorContext<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPayload = unknown
> {
  aggregateId: string;
  commandType: string;
  payload: TPayload;
  meta: TMeta | undefined;
}

export interface EventInterceptorContext<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPayload = unknown
> {
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  meta: TMeta | undefined;
}

export interface RedemeinePlugin<
  TMeta extends Record<string, unknown> = Record<string, unknown>
> {
  onBeforeCommand?: (ctx: CommandInterceptorContext<TMeta, unknown>) => void | Promise<void>;
  onBeforeAppend?: (ctx: EventInterceptorContext<TMeta, unknown>) => unknown | void | Promise<unknown | void>;
  onHydrateEvent?: (ctx: EventInterceptorContext<TMeta, unknown>) => unknown | void | Promise<unknown | void>;
}

/**
 * Represents a dictionary mapping string keys to selector functions.
 * Selectors are pure functions injecting localized state queries directly into command contexts.
 */
export type SelectorsMap<S> = Record<string, (state: ReadonlyDeep<S>, ...args: any[]) => any>;

/**
 * A foundational building block representing a domain event. 
 * Records an intent that has successfully altered the aggregate state.
 */
export interface Event<P = any, T extends EventType | string = EventType> {
  id?: string;
  type: T;
  payload: P;
  headers?: EnvelopeHeaders;
  metadata?: any;
}

/**
 * A foundational building block representing a domain command.
 * Requests a state change and houses the necessary payload for processing validation.
 */
export interface Command<P = any, T extends CommandType | string = CommandType> {
  id?: string;
  type: T;
  payload: P;
  headers?: EnvelopeHeaders;
  metadata?: any;
}

/**
 * Describes the originating command attached to emitted event metadata.
 * This supports command-to-event traceability, including one-command-many-events flows.
 */
export interface EventCommandLink<P = any, T extends CommandType | string = CommandType> {
  id?: string;
  type: T;
  summary?: P;
  storeRef?: string;
}

/**
 * The foundational base for state objects that are treated as entities.
 * Enforces a required structural `id`.
 */
export interface BaseEntity {
  id: string | number;
}

/**
 * Represents the underlying record map managed by the `EntityArray` utility.
 * Foundational for strong typing arrays of `BaseEntity`.
 */
export type Collection<T extends BaseEntity> = T[];

/**
 * Utility toolkit for safely managing collections (arrays) of entities within Immer event handlers.
 * Ensures references are correctly mutated without mutating the entire array instance, preserving predictability.
 */
export const EntityArray = {
  /**
   * Updates an entity by ID if it exists; otherwise, appends it strictly.
   * 
   * @example
   * EntityArray.upsert(state.orderLines, { id: 'line-1', sku: 'A1' });
   */
  upsert<T extends BaseEntity>(array: T[], item: T): void {
    const index = array.findIndex(e => e.id === item.id);
    if (index >= 0) {
      Object.assign(array[index], item);
    } else {
      array.push(item);
    }
  },

  /**
   * Applies partial updates to an entity matching the given ID. Fails silently if missing.
   * 
   * @example
   * EntityArray.update(state.orderLines, 'line-1', { isCancelled: true });
   */
  update<T extends BaseEntity>(array: T[], id: string | number, patch: Partial<T>): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      Object.assign(array[index], patch);
    }
  },

  /**
   * Slices the entity matching the ID out of the collection entirely.
   * 
   * @example
   * EntityArray.remove(state.orderLines, 'line-1');
   */
  remove<T extends BaseEntity>(array: T[], id: string | number): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      array.splice(index, 1);
    }
  }
};

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

export type PackedCommand<S, Args extends any[], P> = {
  /**
   * Defines the public API signature and serializable Command payload structure.
   */
  pack: (...args: Args) => P;
  handler: (state: ReadonlyDeep<S>, payload: P) => Event<any, any> | Event<any, any>[];
};

export type PackedCommandWithMeta<S, Args extends any[], P, TMeta extends Record<string, unknown> = Record<string, unknown>> =
  PackedCommand<S, Args, P> & {
    meta?: TMeta;
  };

export type ShorthandCommandWithMeta<S, Args extends any[] = any[], TMeta extends Record<string, unknown> = Record<string, unknown>> = {
  handler: (state: ReadonlyDeep<S>, ...args: Args) => Event<any, any> | Event<any, any>[];
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
