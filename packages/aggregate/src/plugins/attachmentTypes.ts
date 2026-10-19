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
type ExtensionOf<H, K extends 'commandEnvelope' | 'eventEnvelope'> = H extends { kind: 'aggregate-event' }
  ? K extends keyof H ? undefined extends H[K] ? Partial<DescriptorExtension<NonNullable<H[K]>>>
    : DescriptorExtension<H[K]> : {}
  : {};
export type MountedEnvelopes<P extends readonly unknown[], K extends 'commandEnvelope' | 'eventEnvelope'> =
  P extends readonly [infer H, ...infer T] ? ExtensionOf<H, K> & MountedEnvelopes<T, K>
    : [P[number]] extends [never] ? {} : Partial<Intersection<ExtensionOf<P[number], K>>>;
export type EnvelopeRouting = {
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  address?: unknown;
  correlation?: unknown;
};
export type PreparedCommand<P, T extends string, X extends object = {}> = Command<P, T> & EnvelopeRouting & X;
type PreviousEnvelope<A, K extends 'command' | 'event'> = A extends { readonly __envelopeTypes?: infer X }
  ? K extends keyof NonNullable<X> ? NonNullable<X>[K] : {} : {};
type CommandExtensions<A, P extends readonly unknown[]> = PreviousEnvelope<A, 'command'> & MountedEnvelopes<P, 'commandEnvelope'>;
type EventExtensions<A, P extends readonly unknown[]> = PreviousEnvelope<A, 'event'> & MountedEnvelopes<P, 'eventEnvelope'>;
type BranchKeys<S> = S extends unknown ? keyof S : never;
type InvalidSourceEvent<A, H> = H extends { source: infer Source extends AggregatePluginSource; events: infer Handlers }
  ? A extends AggregatePluginSource ? {
    [K in keyof Handlers]-?: [Handlers[K]] extends [undefined] ? never : K extends keyof PluginPayloads<Source>
      ? K extends keyof PluginPayloads<A> ? [PluginPayloads<A>[K]] extends [PluginPayloads<Source>[K]] ? never : K : K
      : K
  }[keyof Handlers] : never : never;
export type ValidSourceEvents<A, P extends readonly unknown[]> = {
  [K in keyof P]: [InvalidSourceEvent<A, P[K]>] extends [never] ? P[K] : never;
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
    prepareCommand: <C extends Command<unknown, string>>(state: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>, command: C) => PreparedCommand<C['payload'], C['type'], CommandExtensions<A, P>>;
    process: (state: AggregateStateView<AggregateStateModel<A> & MountedPlugins<P>>, command: Command<unknown, string>) => (Event & EnvelopeRouting & EventExtensions<A, P>)[];
    readonly __envelopeTypes?: { command: CommandExtensions<A, P>; event: EventExtensions<A, P> };
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
