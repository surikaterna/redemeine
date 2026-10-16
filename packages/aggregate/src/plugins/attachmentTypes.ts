import type { Command, Event, ExtractPluginExtensions, RedemeinePlugin } from '@redemeine/kernel';
import type { AggregatePluginId } from './types';

// Existential callback signatures: implementations are invoked only with their own mounted state.
export type EventPlugin = {
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
export type RegistrationTuple = readonly [] | readonly [PluginRegistration, ...PluginRegistration[]];
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends ((value: infer I) => void) ? I : never;
export type RegistrationExtensions<P> = Intersection<ExtractPluginExtensions<Exclude<P, EventPlugin>>>;
type ArrayMounts<P> = {
  [Id in Extract<P, EventPlugin>['id']]?: ReturnType<Extract<P, { id: Id } & EventPlugin>['initialize']>;
};
export type MountedPlugins<P extends readonly unknown[]> = P extends readonly [infer H, ...infer T]
  ? (H extends { kind: 'aggregate-event'; id: infer Id extends string; initialize: () => infer S } ? Record<Id, S> : {}) & MountedPlugins<T>
  : ArrayMounts<P[number]>;
type BranchKeys<S> = S extends unknown ? keyof S : never;
// Arrays provide no presence or ordering proof; prerequisites must already hold on every host branch.
type InvalidArrayMember<S, H> = H extends EventPlugin
  ? [H['id']] extends [AggregatePluginId<H['id']>]
    ? Extract<H['id'], BranchKeys<S>> extends never
      ? H extends { source: { initialState: infer Required } } ? [S] extends [Required] ? never : true : never
      : true
    : true
  : never;
export type ValidRegistrations<S, P extends readonly unknown[]> = P extends readonly [infer H, ...infer T]
  ? [H] extends [{ kind: 'aggregate-event'; id: infer Id extends string; initialize: () => infer State }]
    ? [Id] extends [AggregatePluginId<Id>] ? Id extends BranchKeys<S> ? never
      : H extends { source: { initialState: infer Required } }
        ? [S] extends [Required] ? readonly [H, ...ValidRegistrations<S & Record<Id, State>, T>] : never
        : readonly [H, ...ValidRegistrations<S & Record<Id, State>, T>]
      : never
    : readonly [H, ...ValidRegistrations<S, T>]
  : { [K in keyof P]: P[K] & (true extends InvalidArrayMember<S, P[K]> ? never : unknown) };
export type ValidRegistrationArray<S, P extends readonly PluginRegistration[]> =
  number extends P['length'] ? true extends InvalidArrayMember<S, P[number]> ? never : P : never;

export type DecoratedAggregate<A extends { initialState: unknown }, P extends readonly unknown[]> =
  Omit<A, 'initialState' | 'apply' | 'applyToDraft' | 'process' | 'withPlugins' | 'plugins'> & {
    initialState: A['initialState'] & MountedPlugins<P>;
    apply: (state: A['initialState'] & MountedPlugins<P>, event: Event) => A['initialState'] & MountedPlugins<P>;
    applyToDraft: (draft: A['initialState'] & MountedPlugins<P>, event: Event) => void;
    process: (state: A['initialState'] & MountedPlugins<P>, command: Command<unknown, string>) => Event[];
    plugins: A extends { plugins?: (infer Legacy)[] }
      ? RedemeinePlugin<ExtractPluginExtensions<Legacy> & RegistrationExtensions<P[number]>>[] : never;
  } & AggregateDecoration<A['initialState'] & MountedPlugins<P>, A extends { __registryType?: infer Registry } ? Registry : {}>;

export interface AggregateDecoration<S, Reserved = {}> {
  readonly aggregatePlugins?: readonly EventPlugin[];
  validateState?(state: unknown): void;
  withPlugins<const P extends RegistrationTuple>(
    ...plugins: P & ValidRegistrations<S & Reserved, P>
  ): DecoratedAggregate<this & { initialState: S }, P>;
  withPlugins<const P extends readonly PluginRegistration[]>(
    ...plugins: P & ValidRegistrationArray<S & Reserved, P>
  ): DecoratedAggregate<this & { initialState: S }, P>;
}
