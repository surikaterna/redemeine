import type { Event } from '@redemeine/kernel';
import type { Draft } from 'immer';

export type AggregatePluginSource = {
  aggregateType: string;
  initialState: unknown;
  pure: { eventProjectors: Record<string, unknown> };
};

type ProjectorPayload<P> = P extends (...args: infer Args) => unknown
  ? Args extends [unknown, infer E, ...unknown[]]
    ? E extends { payload: infer Payload } ? Payload : unknown
    : unknown
  : unknown;

type Payloads<A> = A extends AggregatePluginSource
  ? { [K in keyof A['pure']['eventProjectors'] & string]: ProjectorPayload<A['pure']['eventProjectors'][K]> }
  : Record<string, unknown>;

// Keep Projection's resolved-name semantics without an Aggregate -> Projection dependency.
type ResolvedEventType<A, K extends string> = A extends { types: { events: infer Names } }
  ? K extends keyof Names ? Extract<Names[K], string> : string
  : K | `${A extends { aggregateType: infer Name extends string } ? Name : string}.${K}.event`;

type PluginReadonlyDeep<T> = T extends Date ? Readonly<Omit<Date, `set${string}`>>
  : T extends (...args: never[]) => unknown ? T
  : T extends object ? { readonly [K in keyof T]: PluginReadonlyDeep<T[K]> } : T;

export type AggregatePluginContext<A> = Readonly<{
  aggregateType: string;
  state: A extends AggregatePluginSource ? PluginReadonlyDeep<A['initialState']> : unknown;
}>;

export type AggregatePluginHandler<S, A, E = Event<unknown, string>> = (
  draft: Draft<S>, event: PluginReadonlyDeep<E>, context: AggregatePluginContext<A>
) => undefined;

export type AggregatePluginEvents<S, A> = {
  [K in keyof Payloads<A> & string]?: AggregatePluginHandler<S, A, Event<A extends AggregatePluginSource ? Payloads<A>[K] : unknown, ResolvedEventType<A, K>>>;
};

export interface AggregateEventPlugin<Id extends string, S extends object, A = undefined> {
  readonly kind: 'aggregate-event';
  readonly id: Id;
  readonly source: A;
  readonly initialize: () => S;
  readonly events: Readonly<AggregatePluginEvents<S, A>>;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly onEvent: AggregatePluginHandler<S, A> | undefined;
}

export interface AggregatePluginBuilder<Id extends string, S extends object, A> {
  events(handlers: AggregatePluginEvents<S, A>): AggregatePluginBuilder<Id, S, A>;
  onEvent(handler: AggregatePluginHandler<S, A>): AggregatePluginBuilder<Id, S, A>;
  build(): AggregateEventPlugin<Id, S, A>;
}

export interface AggregatePluginStateBuilder<Id extends string, A> {
  /** Trusted factory: return fresh, plugin-owned Immer-compatible state for independent host instances; not sandboxed. */
  state<S extends object>(initialize: (() => S) & (S extends PromiseLike<unknown> ? never : unknown)): AggregatePluginBuilder<Id, S, A>;
}

type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never;
type ReservedId = keyof Object | '__proto__' | 'prototype' | '__defineGetter__' | '__defineSetter__' | '__lookupGetter__' | '__lookupSetter__';
export type AggregatePluginId<Id extends string> = string extends Id ? never
  : true extends IsUnion<Id> ? never
  : Id extends '' | ReservedId ? never : Id;
