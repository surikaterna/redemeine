import type { Event, PluginExtensions, RedemeinePlugin, Contract, ReadonlyDeep } from '@redemeine/kernel';
import type { EntityPackage, AggregateEntityRegistry, BuiltAggregate } from '@redemeine/aggregate';
import type { MirageContextPolymorphicBinding, MirageContextSingleBinding } from '@redemeine/aggregate';

export type MountKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

export type MountMetadata = {
    kind: MountKind;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[] | undefined;
    knownKeys?: readonly string[] | undefined;
};

export type InvocationContext = {
    idsPayload: Record<string, unknown>;
    packPrefix: unknown[];
    entityPk?: Record<string, unknown> | undefined;
};

export type { BuiltAggregate } from '@redemeine/aggregate';

/**
 * A mapped record of executable live commands bound directly to the aggregate instance.
 */
type IsBroadRecord<T> = string extends keyof T ? true : false;
export type DispatchResult<T> = T | Promise<T>;

export type MirageCommandMap<S, M> = IsBroadRecord<M> extends true
    ? {}
    : {
        [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
            ? (...args: Args extends any[] ? Args : never) => DispatchResult<S>
            : [M[K]] extends [void] | [undefined] | [never]
                ? () => DispatchResult<S>
                : (payload: M[K]) => DispatchResult<S>;
    };

export type BuiltAggregateCommands<T> = T extends BuiltAggregate<any, infer M, any, any> ? M : Record<string, any>;
export type BuiltAggregateState<T> = T extends BuiltAggregate<infer S, any, any, any> ? S : never;
export type BuiltAggregateRegistry<T> = T extends BuiltAggregate<any, any, any, infer R, any> ? R : {};
export type BuiltAggregateSelectors<T> = T extends BuiltAggregate<any, any, any, any, infer Sel> ? Sel : {};
export type BuiltAggregatePlugins<T> = T extends BuiltAggregate<any, any, any, any, any, infer P> ? P : {};

/**
 * Configuration options strictly passed during the instantiation of a Mirage instance.
 */
export interface MirageOptions<TPlugins extends PluginExtensions = {}> {
    contract?: Contract;
    strict?: boolean;
    plugins?: RedemeinePlugin<TPlugins>[];
}

/**
 * A private symbol used to access internal dispatch mechanisms (MirageCore) 
 * without polluting the public aggregate API methods.
 */
export const MirageCoreSymbol = Symbol('MirageCore');

export type HydrationEvents<TEvent> = Iterable<TEvent> | AsyncIterable<TEvent>;
