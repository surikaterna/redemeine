import type { Event, Command, EventType, CommandType, NamingStrategy, AggregateHooks, PluginContext, PluginExtensions, CommandContext, CommandIntents, MergePluginExtensions, RedemeinePlugin, ReadonlyDeep, Contract } from '@redemeine/kernel';
import type { EntityPackage } from '../createEntity';
import type { GenericCommandFactory, AnyFunction } from '../redemeineComponent';
import type { Merge } from './Merge';
import type { AllKeys } from './AllKeys';
import type { EventEmitterFactory, MapCommandsToPayloads } from './aggregateTyping';
import type {
    AggregateEntityRegistry,
    MountedStructureMetadata,
    MountedEntityPackage,
    EntityMountOverrides,
    EntityListOptions,
    EntityMapOptions,
    EntityRegistryListEntry,
    EntityRegistryMapEntry,
    EntityRegistryValueObjectEntry,
    EntityRegistryValueObjectListEntry,
    EntityRegistryValueObjectMapEntry
} from './entityMount';
import type { RedemeineEventDefinition, NormalizeEventDefinitions, RedemeineCommandDefinition } from '../redemeineComponent';
import type { bindContext } from '../bindContext';

export type AggregateSelectorUtils = { bindContext: typeof bindContext };

export type AggregateSelector<S> =
    | ((state: ReadonlyDeep<S>, ...args: unknown[]) => unknown)
    | ((state: ReadonlyDeep<S>, utils: AggregateSelectorUtils, ...args: unknown[]) => unknown);

export type AggregateSelectorsMap<S> = Record<string, AggregateSelector<S>>;

export type UnionToIntersection<U> = (
    U extends unknown ? (arg: U) => void : never
) extends ((arg: infer I) => void)
    ? I
    : never;

// SAFETY: `any` in AggregateMixinLike defaults required for variance — mixins must be assignable from any state shape
export type AggregateMixinLike<S = any, Commands = {}, Registry extends AggregateEntityRegistry = {}> = {
    readonly __stateType?: S;
    commands?: Commands;
    events?: Record<string, AnyFunction>;
    projectors?: Record<string, AnyFunction>;
    eventMetadata?: Record<string, Record<string, unknown> | undefined>;
    eventOverrides?: Record<string, string>;
    commandOverrides?: Record<string, string>;
    selectors?: AggregateSelectorsMap<S>;
    commandFactory?: GenericCommandFactory;
    mounts?: Record<string, MountedStructureMetadata>;
    mountedEntities?: MountedEntityPackage[];
    __registryType?: Registry;
};

// SAFETY: `any[]` in MergeMixins required for tuple/array type distribution
export type ExtractMixinCommands<T> = T extends { commands?: infer CPayloads } ? CPayloads : {};
export type MergeMixins<T extends any[]> = Merge<ExtractMixinCommands<T[number]> & {}>;
export type ExtractMixinRegistry<T> = T extends { __registryType?: infer Registry } ? Registry : {};
export type MergeMixinRegistries<T extends any[]> = Merge<ExtractMixinRegistry<T[number]> & {}>;
export type ExtractMixinState<T> = T extends { __stateType?: infer MS } ? MS : never;
// SAFETY: `any` required for contravariant mixin compatibility checks
export type CompatibleMixins<S, T extends AggregateMixinLike<any, any, any>[]> = {
    [K in keyof T]: S extends ExtractMixinState<T[K]> ? T[K] : never;
};

export type MapEntityCommands<Name extends string, CPayloads> = {
    [K in keyof CPayloads as K extends string ? `${Name}${Capitalize<K>}` : never]: CPayloads[K]
};

// SAFETY: `any` in EntityPackage type params required for structural pattern matching via infer
export type ExtractEntityCommands<T> = T extends EntityPackage<any, infer EName, any, any, infer CPayloads, any>
    ? MapEntityCommands<EName, CPayloads>
    : {};

export type MergeEntities<T extends any[]> = Merge<ExtractEntityCommands<T[number]> & {}>;
export type AggregateCommandKeys<T> = AllKeys<T & {}>;
// SAFETY: `any` required for conditional type inference on event projector shapes
export type AggregateEventProjectorsMap<TEvents> = TEvents extends Record<string, (...args: any[]) => any>
    ? TEvents
    : Record<string, (...args: unknown[]) => unknown>;

// SAFETY: `any` in EntityPackage positions below required for existential type extraction via `infer`
export type RegistryFromNamedEntities<EN extends Record<string, any>> = {
    [K in keyof EN as EN[K] extends EntityPackage<any, any, any, any, any, any> ? K : never]: EntityRegistryListEntry<Extract<EN[K], EntityPackage<any, any, any, any, any, any>>, 'id'>;
};

export type RegistryFromPackages<T extends readonly EntityPackage<any, any, any, any, any, any>[]> = UnionToIntersection<
    T[number] extends infer P
        ? P extends EntityPackage<any, infer PName, any, any, any, any>
            ? { [K in PName]: EntityRegistryListEntry<P, 'id'> }
            : {}
        : {}
>;

/**
 * The core builder interface for composing Aggregates in Redemeine.
 * Uses a fluent chained API to progressively layer events, commands, mixins, and entities.
 * SAFETY: `any` in EntityPackage/AggregateMixinLike constraint positions throughout this interface
 * is required for TypeScript to perform `infer` extraction on generic type parameters.
 */
export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}, Sel = {}, Registry extends AggregateEntityRegistry = {}, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> {
    extends: <ParentM, ParentE, ParentEOverrides, ParentSel, ParentRegistry extends AggregateEntityRegistry>(
        parentBuilder: AggregateBuilder<S, any, ParentM, ParentE, ParentEOverrides, ParentSel, ParentRegistry, TMeta, TPlugins>
    ) => AggregateBuilder<S, Name, M & ParentM, E & ParentE, EOverrides & ParentEOverrides, Sel & ParentSel, Registry & ParentRegistry, TMeta, TPlugins>;

    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides, Sel, Registry & RegistryFromNamedEntities<EN> & RegistryFromPackages<T>, TMeta, TPlugins>;

    entityList: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>, const PK extends string | readonly string[] = 'id'>(
        name: EN,
        entityComponent: T,
        options?: EntityListOptions<PK>,
        mountOverrides?: EntityMountOverrides
    ) => AggregateBuilder<S, Name, M & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer CPayloads, any> ? CPayloads : {}>, E, EOverrides, Sel, Registry & { [K in EN]: EntityRegistryListEntry<T, PK> }, TMeta, TPlugins>;

    entityMap: <EN extends string, Keys extends string, T extends EntityPackage<any, any, any, any, any, any>>(
        name: EN,
        entityComponent: T,
        options?: EntityMapOptions<Keys>,
        mountOverrides?: EntityMountOverrides
    ) => AggregateBuilder<S, Name, M & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer CPayloads, any> ? CPayloads : {}>, E, EOverrides, Sel, Registry & { [K in EN]: EntityRegistryMapEntry<T, Keys> }, TMeta, TPlugins>;

    valueObject: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectEntry }, TMeta, TPlugins>;

    valueObjectList: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectListEntry }, TMeta, TPlugins>;

    valueObjectMap: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectMapEntry }, TMeta, TPlugins>;

    mixins: <T extends AggregateMixinLike<any, any, any>[]>(
        ...mixins: CompatibleMixins<S, T>
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>, E, EOverrides, Sel, Registry & MergeMixinRegistries<T>, TMeta, TPlugins>;

    plugins: <P extends RedemeinePlugin<any>[]>(
        ...plugins: P
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins & MergePluginExtensions<P>>;

    selectors: {
        <NewSel extends AggregateSelectorsMap<S>>(
            selectors: NewSel
        ): AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel, Registry, TMeta, TPlugins>;
        <NewSel extends AggregateSelectorsMap<S>>(
            selectorFactory: (utils: AggregateSelectorUtils) => NewSel
        ): AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel, Registry, TMeta, TPlugins>;
    };

    events: <NewE extends Record<string, RedemeineEventDefinition<S, TMeta>>>(
        events: NewE
    ) => AggregateBuilder<S, Name, M, E & NormalizeEventDefinitions<NewE>, EOverrides, Sel, Registry, TMeta, TPlugins>;

    overrideEventNames: <NewEOverrides extends Partial<Record<string, EventType>>>(
        overrides: NewEOverrides
    ) => AggregateBuilder<S, Name, M, E, EOverrides & NewEOverrides, Sel, Registry, TMeta, TPlugins>;

    naming: (strategy: Partial<NamingStrategy>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    commands: <C extends Record<string, RedemeineCommandDefinition<S, TMeta, TPlugins>>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>, context: { selectors: Sel; commands: CommandContext<CommandIntents<M>>; plugins?: PluginContext<TPlugins> }) => C
    ) => AggregateBuilder<S, Name, M & MapCommandsToPayloads<C>, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    overrideCommandNames: (overrides: Partial<Record<AggregateCommandKeys<M>, CommandType>>) =>
        AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    hooks: (hooks: AggregateHooks<S>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    onUnmatchedEvent: (handler: (eventType: string, aggregateName: string) => void) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    contract: (contract: Contract) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    build: () => {
        aggregateType: Name;
        initialState: S;
        process: (state: S, command: Command<unknown, string>) => Event[];
        apply: (state: S, event: Event) => S;
        applyToDraft: (draft: S, event: Event) => void;
        commandCreators: {
            [K in keyof M]: M[K] extends { args: infer Args, payload: infer P }
                ? (...args: Args extends any[] ? Args : never) => { type: string; payload: P }
                : [M[K]] extends [void] | [undefined] | [never]
                    ? () => { type: string; payload: void }
                    : (payload: M[K]) => { type: string; payload: M[K] };
        };
        eventCreators: EventEmitterFactory<Name, E, EOverrides>;
        pure: {
            commandProcessors: Record<string, AnyFunction>;
            eventProjectors: AggregateEventProjectorsMap<E>;
        };
        selectors: Sel;
        hooks: AggregateHooks<S>;
        mounts: Record<string, MountedStructureMetadata>;
        metadata: {
            commands: Record<string, { meta?: TMeta }>;
            events: Record<string, { meta?: TMeta }>;
        };
        types: {
            commands: Record<string, string>;
            events: Record<string, string>;
        };
        plugins: RedemeinePlugin<TPlugins>[];
        __registryType?: Registry;
    };

    _state: {
        events: Record<string, AnyFunction>;
        eventMetadata: Record<string, Record<string, unknown> | undefined>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        commandsFactory: GenericCommandFactory;
        mixins: AggregateMixinLike<S>[];
        selectors: Record<string, AnyFunction>;
        hooks: AggregateHooks<S>;
        plugins: RedemeinePlugin<TPlugins>[];
    };
}
