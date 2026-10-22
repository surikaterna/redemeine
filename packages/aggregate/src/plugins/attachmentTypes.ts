import type { Command, Event, ExtractPluginExtensions, RedemeinePlugin } from '@redemeine/kernel';
import type { AggregatePluginId, AggregatePluginSource, PluginPayloads } from './types';
import type { EnvelopeSlot } from './envelopeDescriptor';
import type { EnvelopeDescriptor } from './envelopeTypes';
import type { Draft } from 'immer';
import type { AggregateStateModel, AggregateStateView } from '../types/aggregateState';

// Existential callback signatures: implementations are invoked only with their own mounted state.
export type EventPlugin = {
  readonly commandEnvelope?: EnvelopeSlot | undefined;
  readonly eventEnvelope?: EnvelopeSlot | undefined;
  readonly kind: 'aggregate-event';
  readonly id: string;
  readonly source: unknown;
  readonly initialize: (() => object) | undefined;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly events: Readonly<Record<string, ((...args: never[]) => unknown) | undefined>>;
  readonly onEvent: ((...args: never[]) => unknown) | undefined;
};
// Registration stores hooks without invoking them; retain contextual types while accepting extension-specific contexts.
type RegistrationHook<F> = F extends (...args: infer A) => infer R ? { hook(...args: A): R }['hook'] : F;
export type LegacyRegistration = { [K in keyof RedemeinePlugin]: RegistrationHook<RedemeinePlugin[K]> };
export type PluginRegistration = LegacyRegistration | EventPlugin;
export type RegistrationTuple = readonly [] | readonly [PluginRegistration, ...PluginRegistration[]];
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends ((value: infer I) => void) ? I : never;
export type RegistrationExtensions<P> = Intersection<ExtractPluginExtensions<Exclude<P, EventPlugin>>>;
type StatefulPlugin = EventPlugin & { readonly initialize: () => object };
type ArrayMounts<P> = {
  [Id in Extract<P, StatefulPlugin>['id']]?: ReturnType<Extract<P, { id: Id } & StatefulPlugin>['initialize']>;
};
export type MountedPlugins<P extends readonly unknown[]> = P extends readonly [infer H, ...infer T]
  ? (H extends { kind: 'aggregate-event'; id: infer Id extends string; initialize: () => infer S } ? Record<Id, S> : {}) & MountedPlugins<T>
  : ArrayMounts<P[number]>;
type DescriptorExtension<D> = [D] extends [never] ? {}
  : D extends EnvelopeDescriptor<infer X, infer _Context> ? X : {};
type EnvelopeKey = 'commandEnvelope' | 'eventEnvelope';
type RequiredExtension<H, K extends EnvelopeKey> = [H] extends [{ kind: 'aggregate-event' }]
  ? K extends keyof H ? undefined extends H[K] ? {} : DescriptorExtension<H[K]> : {} : {};
// Box each registration so a descriptor's own union is never intersected with itself.
type PossibleMember<H, K extends EnvelopeKey> = H extends { kind: 'aggregate-event' }
  ? K extends keyof H ? [NonNullable<H[K]>] extends [never] ? never
    : { extension: DescriptorExtension<NonNullable<H[K]>> } : never : never;
type OptionalMember<H, K extends EnvelopeKey> = K extends keyof H
  ? undefined extends H[K] ? PossibleMember<H, K> : never : never;
type Contributions<G = {}, P = never> = { guaranteed: G; possible: P };
type OpenKey<K extends PropertyKey> = {} extends Record<K, unknown> ? true : false;
type RequiredPart<X> = { [K in keyof X as {} extends Pick<X, K> ? never : K]: X[K] };
type Field<X, K extends PropertyKey> = X extends unknown ? K extends keyof X ? Required<Pick<X, K>>[K] : never : never;
type OptionalPart<X, Other> = {
  [K in keyof X as {} extends Pick<X, K> ? K : never]?: OpenKey<K> extends true ? unknown : Field<X, K> | Field<Other, K>
};
// A successful required writer excludes optional competing writes, not the optional writer's entire branch.
type GuaranteedShape<A, B> = A extends unknown ? B extends unknown
  ? RequiredPart<A> & RequiredPart<B> & OptionalPart<A, B> & OptionalPart<B, A> : never : never;
type Combine<L extends Contributions<unknown, unknown>, R extends Contributions<unknown, unknown>> =
  Contributions<GuaranteedShape<L['guaranteed'], R['guaranteed']>, L['possible'] | R['possible']>;
type MemberContributions<H, K extends EnvelopeKey> = Contributions<RequiredExtension<H, K>, OptionalMember<H, K>>;
// Flattened variadic arrays can erase required members between batches; retain their presence evidence separately.
export type AppendRegistrations<L extends readonly unknown[], R extends readonly unknown[]> = [...L, ...R] & {
  readonly __envelopeContributions: { [K in EnvelopeKey]: Combine<MountedContributions<L, K>, MountedContributions<R, K>> }
    & { registrations: [...L, ...R] };
};
type MountedContributions<P extends readonly unknown[], K extends EnvelopeKey> =
  P extends { readonly __envelopeContributions: infer C extends Record<EnvelopeKey, Contributions<unknown, unknown>> } ? C[K]
    : P extends readonly [infer H, ...infer T] ? Combine<MemberContributions<H, K>, MountedContributions<T, K>>
      : P extends readonly [...infer T, infer H] ? Combine<MountedContributions<T, K>, MemberContributions<H, K>>
        : Contributions<{}, PossibleMember<P[number], K>>;
type MemberExtensions<U> = U extends { extension: infer X } ? X : never;
// Possible writers provide independent fields, never cross-field provenance or correlation.
type PossibleFields<X> = { [K in BranchKeys<X>]?: OpenKey<K> extends true ? unknown : Field<X, K> };
type WithoutKeys<X, K extends PropertyKey> = X extends unknown ? Omit<X, K> : never;
type WithPossible<G, P> = GuaranteedShape<G, P>;
type Render<C extends Contributions<unknown, unknown>, K extends EnvelopeKey> =
  [C['possible']] extends [never] ? C['guaranteed'] : WithPossible<C['guaranteed'],
     WithoutKeys<PossibleFields<MemberExtensions<C['possible']>>, K extends 'eventEnvelope' ? 'headers' : never>>;
export type MountedEnvelopes<P extends readonly unknown[], K extends EnvelopeKey> = Render<MountedContributions<P, K>, K>;
export type EnvelopeRouting = {
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  address?: unknown;
  correlation?: unknown;
};
// Distribute the original command, projecting only canonical fields rather than retaining raw extras.
export type PreparedCommand<C extends Command<unknown, string>, X extends object = {}> =
  C extends unknown ? Command<C['payload'], C['type']> & EnvelopeRouting & X : never;
type GuaranteedHeaders<X> = [X] extends [{ headers: unknown }] ? Pick<X, Extract<'headers', keyof X>> : {};
export type PreparedEvent<X> = Omit<Event, keyof GuaranteedHeaders<X>> & EnvelopeRouting & X;
type PreviousContributions<A, K extends EnvelopeKey> = A extends {
  readonly __envelopeTypes?: { readonly contributions: infer C }
} ? K extends keyof C ? C[K] extends Contributions<unknown, unknown> ? C[K] : Contributions : Contributions : Contributions;
type AttachedContributions<A, P extends readonly unknown[], K extends EnvelopeKey> =
  Combine<PreviousContributions<A, K>, MountedContributions<P, K>>;
export type AttachedEnvelopeTypes<A, P extends readonly unknown[]> = {
  command: Render<AttachedContributions<A, P, 'commandEnvelope'>, 'commandEnvelope'>;
  event: Render<AttachedContributions<A, P, 'eventEnvelope'>, 'eventEnvelope'>;
  // Keep presence evidence separate from the rendered optional shape across builder/attachment chains.
  contributions: { [K in EnvelopeKey]: AttachedContributions<A, P, K> };
};
export type MountedEventExtensions<P extends readonly unknown[]> = MountedEnvelopes<P, 'eventEnvelope'>;
type CommandExtensions<A, P extends readonly unknown[]> = AttachedEnvelopeTypes<A, P>['command'];
type EventExtensions<A, P extends readonly unknown[]> = AttachedEnvelopeTypes<A, P>['event'];
type BranchKeys<S> = S extends unknown ? keyof S : never;
type InvalidSourceEvent<A, H> = H extends { source: infer Source extends AggregatePluginSource; events: infer Handlers }
  ? A extends AggregatePluginSource ? {
    [K in keyof Handlers]-?: [Handlers[K]] extends [undefined] ? never : K extends keyof PluginPayloads<Source>
      ? K extends keyof PluginPayloads<A> ? [PluginPayloads<A>[K]] extends [PluginPayloads<Source>[K]] ? never : K : K
      : K
  }[keyof Handlers] : never : never;
type SourceEventRegistrations<P extends readonly unknown[]> =
  P extends { readonly __envelopeContributions: { registrations: infer R extends readonly unknown[] } } ? R : P;
export type ValidSourceEvents<A, P extends readonly unknown[]> = {
  [K in keyof SourceEventRegistrations<P>]: [InvalidSourceEvent<A, SourceEventRegistrations<P>[K]>] extends [never]
    ? SourceEventRegistrations<P>[K] : never;
};
// Arrays provide no presence or ordering proof; prerequisites must already hold on every host branch.
type InvalidArrayMember<S, H> = H extends EventPlugin
  ? [H['id']] extends [AggregatePluginId<H['id']>]
    ? Extract<H['id'], BranchKeys<S>> extends never
      ? H extends { source: { initialState: infer Required } } ? [S] extends [Required] ? never : true : never
      : true
    : true
  : never;
export type ValidRegistrations<S, P extends readonly unknown[], Seen extends string = never> = P extends readonly [infer H, ...infer T]
  ? [H] extends [EventPlugin & { id: infer Id extends string }]
    ? [Id] extends [AggregatePluginId<Id>] ? Id extends BranchKeys<S> | Seen ? never
      : H extends { source: { initialState: infer Required } }
        ? [S] extends [Required] ? readonly [H, ...ValidRegistrations<S & MountedPlugins<[H]>, T, Seen | Id>] : never
        : readonly [H, ...ValidRegistrations<S & MountedPlugins<[H]>, T, Seen | Id>]
      : never
    : readonly [H, ...ValidRegistrations<S, T, Seen>]
  : { [K in keyof P]: P[K] & (true extends InvalidArrayMember<S, P[K]> ? never : unknown) };
export type ValidRegistrationArray<S, P extends readonly PluginRegistration[]> =
  number extends P['length'] ? true extends InvalidArrayMember<S, P[number]> ? never : P : never;

export type DecoratedAggregate<A extends { initialState: unknown }, P extends readonly unknown[]> =
  Omit<A, 'initialState' | '__stateType' | 'apply' | 'applyToDraft' | 'process' | 'prepareCommand' | 'withPlugins' | 'plugins' | '__envelopeTypes'> & {
    readonly initialState: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>;
    readonly __stateType?: AggregateStateModel<A> & MountedPlugins<P>;
    apply: (state: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>, event: Event) => AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>;
    applyToDraft: (draft: Draft<AggregateStateModel<A> & MountedPlugins<P>>, event: Event) => void;
    prepareCommand: <C extends Command<unknown, string>>(state: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>, command: C) => PreparedCommand<C, CommandExtensions<A, P>>;
    process: (state: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>, command: Command<unknown, string>) => PreparedEvent<EventExtensions<A, P>>[];
    readonly __envelopeTypes?: AttachedEnvelopeTypes<A, P>;
    plugins: A extends { plugins?: (infer Legacy)[] }
      ? RedemeinePlugin<ExtractPluginExtensions<Legacy> & RegistrationExtensions<P[number]>>[] : never;
  } & AggregateDecoration<AggregateStateModel<A> & MountedPlugins<P>, A extends { __registryType?: infer Registry } ? Registry : {}>;

export interface AggregateDecoration<S, Reserved = {}> {
  readonly aggregatePlugins?: readonly EventPlugin[];
  validateState?(state: unknown): void;
  withPlugins<const P extends RegistrationTuple>(
    ...plugins: P & ValidRegistrations<S & Reserved, P> & ValidSourceEvents<this, P>
  ): DecoratedAggregate<this & { readonly initialState: AggregateStateView<S> }, P>;
  withPlugins<const P extends readonly PluginRegistration[]>(
    ...plugins: P & ValidRegistrationArray<S & Reserved, P> & ValidSourceEvents<this, P>
  ): DecoratedAggregate<this & { readonly initialState: AggregateStateView<S> }, P>;
}
