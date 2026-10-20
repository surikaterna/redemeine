import type { Event } from '@redemeine/kernel';
import type { Draft } from 'immer';
import type { AggregateStateView } from '../types/aggregateState';
import type {
  CommandEnvelopeContext,
  CommandEnvelopeDescriptor,
  EnvelopeExtension,
  EnvelopeInitializer,
  EnvelopeParser,
  EnvelopeRecipe,
  EventEnvelopeContext,
  EventEnvelopeDescriptor
} from './envelopeTypes';

export type AggregatePluginSource = {
  aggregateType: string;
  initialState: unknown;
  pure: { eventProjectors: Record<string, unknown> };
};

type ProjectorPayload<P> = P extends (...args: infer Args) => unknown
  ? Args extends [unknown, infer E, ...unknown[]]
    ? E extends { payload: infer Payload }
      ? Payload
      : unknown
    : unknown
  : unknown;

export type PluginPayloads<A> = A extends AggregatePluginSource
  ? { [K in keyof A['pure']['eventProjectors'] & string]: ProjectorPayload<A['pure']['eventProjectors'][K]> }
  : Record<string, unknown>;

// Keep Projection's resolved-name semantics without an Aggregate -> Projection dependency.
type ResolvedEventType<A, K extends string> = A extends { types: { events: infer Names } }
  ? K extends keyof Names
    ? Extract<Names[K], string>
    : string
  : K | `${A extends { aggregateType: infer Name extends string } ? Name : string}.${K}.event`;

export type PluginReadonlyDeep<T> = AggregateStateView<T>;

export type AggregatePluginContext<A> = Readonly<{
  aggregateType: string;
  state: A extends AggregatePluginSource ? PluginReadonlyDeep<A['initialState']> : unknown;
}>;

export type AggregatePluginHandler<S, A, E = Event<unknown, string>> = (
  draft: Draft<S>,
  event: PluginReadonlyDeep<E>,
  context: AggregatePluginContext<A>
) => undefined;

export type AggregatePluginEvents<S, A> = {
  [K in keyof PluginPayloads<A> & string]?: AggregatePluginHandler<
    S,
    A,
    Event<A extends AggregatePluginSource ? PluginPayloads<A>[K] : unknown, ResolvedEventType<A, K>>
  >;
};
export type PluginSourceEvent<A> = {
  [K in keyof PluginPayloads<A> & string]: Event<PluginPayloads<A>[K], ResolvedEventType<A, K>>;
}[keyof PluginPayloads<A> & string];

export interface AggregateEventPlugin<Id extends string, S extends object | undefined, A = undefined, C extends object = {}, E extends object = {}, HasC extends boolean = boolean, HasE extends boolean = boolean> {
  readonly kind: 'aggregate-event';
  readonly propagateCommandHeadersToEvents?: boolean;
  readonly id: Id;
  readonly source: A;
  readonly initialize: S extends object ? () => S : undefined;
  readonly events: S extends object ? Readonly<AggregatePluginEvents<S, A>> : Readonly<Record<string, never>>;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly onEvent: S extends object ? AggregatePluginHandler<S, A> | undefined : undefined;
  readonly commandEnvelope: HasC extends true ? CommandEnvelopeDescriptor<S, A, C> : HasC extends false ? undefined : CommandEnvelopeDescriptor<S, A, C> | undefined;
  readonly eventEnvelope: HasE extends true ? EventEnvelopeDescriptor<S, A, C, E> : HasE extends false ? undefined : EventEnvelopeDescriptor<S, A, C, E> | undefined;
}

export interface AggregatePluginBuilder<
  Id extends string,
  S extends object | undefined,
  A,
  C extends object = {},
  E extends object = {},
  HasC extends boolean = false,
  HasE extends boolean = false,
  Matched extends keyof AggregatePluginEvents<S, A> = never
> {
  propagateCommandHeadersToEvents(): AggregatePluginBuilder<Id, S, A, C, E, HasC, HasE, Matched>;
  events: S extends object ? <const H extends AggregatePluginEvents<S, A>>(handlers: H & Record<Exclude<keyof H, keyof AggregatePluginEvents<S, A>>, never>) => AggregatePluginBuilder<Id, S, A, C, E, HasC, HasE, Matched | Extract<keyof H, keyof AggregatePluginEvents<S, A>>> : never;
  onEvent: S extends object ? (handler: AggregatePluginHandler<S, A>) => AggregatePluginBuilder<Id, S, A, C, E, HasC, HasE, Matched> : never;
  build(): Omit<AggregateEventPlugin<Id, S, A, C, E, HasC, HasE>, 'events'> & { readonly events: S extends object ? Readonly<Pick<AggregatePluginEvents<S, A>, Matched>> : Readonly<Record<string, never>> };
  commandEnvelope: HasC extends true
    ? never
    : {
        <X extends object>(
          initialize: EnvelopeInitializer<X, CommandEnvelopeContext<S, A>> & (X extends EnvelopeExtension<X> ? unknown : never),
          parser?: undefined
        ): AggregatePluginBuilder<Id, S, A, X, E, true, HasE, Matched>;
        <I extends object, X extends object>(
          initialize: EnvelopeInitializer<I, CommandEnvelopeContext<S, A>> & (I extends EnvelopeExtension<I> ? unknown : never),
          parser: EnvelopeParser<X> & (X extends EnvelopeExtension<X> ? unknown : never)
        ): AggregatePluginBuilder<Id, S, A, X, E, true, HasE, Matched>;
      };
  eventEnvelope: HasE extends true
    ? never
    : {
        <X extends object>(
          initialize: EnvelopeInitializer<X, EventEnvelopeContext<S, A, C>> & (X extends EnvelopeExtension<X> ? unknown : never),
          parser?: undefined
        ): AggregatePluginBuilder<Id, S, A, C, X, HasC, true, Matched>;
        <I extends object, X extends object>(
          initialize: EnvelopeInitializer<I, EventEnvelopeContext<S, A, C>> & (I extends EnvelopeExtension<I> ? unknown : never),
          parser: EnvelopeParser<X> & (X extends EnvelopeExtension<X> ? unknown : never)
        ): AggregatePluginBuilder<Id, S, A, C, X, HasC, true, Matched>;
      };
  prepareCommand: HasC extends true ? (recipe: EnvelopeRecipe<C, CommandEnvelopeContext<S, A>>) => AggregatePluginBuilder<Id, S, A, C, E, HasC, HasE, Matched> : never;
  prepareEvent: HasE extends true ? (recipe: EnvelopeRecipe<E, EventEnvelopeContext<S, A, C>>) => AggregatePluginBuilder<Id, S, A, C, E, HasC, HasE, Matched> : never;
}

export interface AggregatePluginStateBuilder<Id extends string, A> extends Omit<AggregatePluginBuilder<Id, undefined, A>, 'events' | 'onEvent'> {
  /** Trusted factory: return fresh, plugin-owned Immer-compatible state for independent host instances; not sandboxed. */
  state<S extends object>(initialize: (() => S) & (S extends PromiseLike<unknown> ? never : unknown)): AggregatePluginBuilder<Id, S, A>;
}

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
type ReservedId = keyof Object | '__proto__' | 'prototype' | '__defineGetter__' | '__defineSetter__' | '__lookupGetter__' | '__lookupSetter__';
export type AggregatePluginId<Id extends string> = string extends Id ? never : true extends IsUnion<Id> ? never : Id extends '' | ReservedId ? never : Id;
