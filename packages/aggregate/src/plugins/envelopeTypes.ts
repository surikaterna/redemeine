import type { Command, Event } from '@redemeine/kernel';
import type { Draft } from 'immer';
import type { AggregatePluginContext, PluginReadonlyDeep } from './types';
import type { EnvelopeRouting } from './attachmentTypes';

export type EnvelopeReservedKey = 'id' | 'type' | 'payload' | 'metadata' | 'headers' | keyof EnvelopeRouting | keyof Object | '__proto__' | 'prototype' | 'then';
export type EnvelopeExtension<X extends object> = X extends PromiseLike<unknown> ? never : Extract<EnvelopeReservedKey, keyof X> extends never ? X : never;
type KeysOfUnion<X> = X extends unknown ? keyof X : never;
export type EventEnvelopeExtension<X extends object> =
  Extract<Exclude<EnvelopeReservedKey, 'headers'>, KeysOfUnion<X>> extends never
    ? 'headers' extends KeysOfUnion<X>
      ? [X] extends [{ headers: Record<string, unknown> | undefined }] ? X : never
      : X extends PromiseLike<unknown> ? never : X
    : never;
export interface EnvelopeParser<X extends object> {
  /** Validates/transforms initializer output, not the incoming command/event. Must be synchronous. */
  parse(value: unknown): X;
}
export type CommandEnvelopeContext<S, A> = AggregatePluginContext<A> &
  Readonly<{
    ownState: PluginReadonlyDeep<S>;
    command: PluginReadonlyDeep<Command<unknown, string> & EnvelopeRouting>;
  }>;
export type EventEnvelopeContext<S, A, C extends object> = AggregatePluginContext<A> &
  Readonly<{
    ownState: PluginReadonlyDeep<S>;
    command: PluginReadonlyDeep<Command<unknown, string> & EnvelopeRouting & C>;
    event: PluginReadonlyDeep<Event<unknown, string> & EnvelopeRouting>;
  }>;
export type EnvelopeInitializer<X extends object, Context> = (input: Readonly<Record<string, unknown>>, context: Context) => X;
export type EnvelopeRecipe<X extends object, Context> = (draft: Draft<X>, context: Context) => undefined;
export interface EnvelopeDescriptor<X extends object, Context> {
  readonly initialize: EnvelopeInitializer<object, Context>;
  readonly parser: EnvelopeParser<X> | undefined;
  readonly recipes: readonly EnvelopeRecipe<X, Context>[];
}
export type CommandEnvelopeDescriptor<S, A, C extends object> = EnvelopeDescriptor<C, CommandEnvelopeContext<S, A>>;
export type EventEnvelopeDescriptor<S, A, C extends object, E extends object> = EnvelopeDescriptor<E, EventEnvelopeContext<S, A, C>>;
