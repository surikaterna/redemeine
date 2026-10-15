import type { Command, Event, ExtractPluginExtensions, RedemeinePlugin } from '@redemeine/kernel';
import type { AggregatePluginId } from './types';
import type { EnvelopeSlot } from './envelopeDescriptor';
import type { EnvelopeDescriptor } from './envelopeTypes';

// Existential callback signatures: implementations are invoked only with their own mounted state.
export type EventPlugin = {
  readonly commandEnvelope?: EnvelopeSlot | undefined;
  readonly eventEnvelope?: EnvelopeSlot | undefined;
  readonly kind: 'aggregate-event';
  readonly id: string;
  readonly source: unknown;
  readonly initialize: () => object;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly events: Readonly<Record<string, ((...args: never[]) => unknown) | undefined>>;
  readonly onEvent: ((...args: never[]) => unknown) | undefined;
};
// Registration stores hooks without invoking them; retain contextual types while accepting extension-specific contexts.
type RegistrationHook<F> = F extends (...args: infer A) => infer R ? { hook(...args: A): R }['hook'] : F;
export type LegacyRegistration = { [K in keyof RedemeinePlugin]: RegistrationHook<RedemeinePlugin[K]> };
export type PluginRegistration = LegacyRegistration | EventPlugin;
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends ((value: infer I) => void) ? I : never;
export type RegistrationExtensions<P> = Intersection<ExtractPluginExtensions<Exclude<P, EventPlugin>>>;
export type MountedPlugins<P extends readonly unknown[]> = P extends readonly [infer H, ...infer T]
  ? (H extends { kind: 'aggregate-event'; id: infer Id extends string; initialize: () => infer S } ? Record<Id, S> : {}) & MountedPlugins<T>
  : {};
type DescriptorExtension<D> = D extends EnvelopeDescriptor<infer X, infer _Context> ? X : {};
type ExtensionOf<H, K extends 'commandEnvelope' | 'eventEnvelope'> = H extends { kind: 'aggregate-event' }
  ? K extends keyof H ? undefined extends H[K] ? Partial<DescriptorExtension<NonNullable<H[K]>>>
    : DescriptorExtension<H[K]> : {}
  : {};
export type MountedEnvelopes<P extends readonly unknown[], K extends 'commandEnvelope' | 'eventEnvelope'> =
  P extends readonly [infer H, ...infer T] ? ExtensionOf<H, K> & MountedEnvelopes<T, K> : {};
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
export type ValidRegistrations<S, P extends readonly unknown[]> = P extends readonly [infer H, ...infer T]
  ? [H] extends [{ kind: 'aggregate-event'; id: infer Id extends string; initialize: () => infer State }]
    ? [Id] extends [AggregatePluginId<Id>] ? Id extends BranchKeys<S> ? never
      : H extends { source: { initialState: infer Required } }
        ? S extends Required ? readonly [H, ...ValidRegistrations<S & Record<Id, State>, T>] : never
        : readonly [H, ...ValidRegistrations<S & Record<Id, State>, T>]
      : never
    : readonly [H, ...ValidRegistrations<S, T>]
  : P;

export type DecoratedAggregate<A extends { initialState: unknown }, P extends readonly unknown[]> =
  Omit<A, 'initialState' | 'apply' | 'applyToDraft' | 'process' | 'prepareCommand' | 'withPlugins' | 'plugins' | '__envelopeTypes'> & {
    initialState: A['initialState'] & MountedPlugins<P>;
    apply: (state: A['initialState'] & MountedPlugins<P>, event: Event) => A['initialState'] & MountedPlugins<P>;
    applyToDraft: (draft: A['initialState'] & MountedPlugins<P>, event: Event) => void;
    prepareCommand: <C extends Command<unknown, string>>(state: A['initialState'] & MountedPlugins<P>, command: C) => PreparedCommand<C['payload'], C['type'], CommandExtensions<A, P>>;
    process: (state: A['initialState'] & MountedPlugins<P>, command: Command<unknown, string>) => (Event & EnvelopeRouting & EventExtensions<A, P>)[];
    readonly __envelopeTypes?: { command: CommandExtensions<A, P>; event: EventExtensions<A, P> };
    plugins: A extends { plugins?: (infer Legacy)[] }
      ? RedemeinePlugin<ExtractPluginExtensions<Legacy> & RegistrationExtensions<P[number]>>[] : never;
  } & AggregateDecoration<A['initialState'] & MountedPlugins<P>, A extends { __registryType?: infer Registry } ? Registry : {}>;

export interface AggregateDecoration<S, Reserved = {}> {
  readonly aggregatePlugins?: readonly EventPlugin[];
  withPlugins<const P extends readonly PluginRegistration[]>(
    ...plugins: P & ValidRegistrations<S & Reserved, P>
  ): DecoratedAggregate<this & { initialState: S }, P>;
}
