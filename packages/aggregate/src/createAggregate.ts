import { Event, Command, EventType, CommandType, NamingStrategy, SelectorsMap, AggregateHooks, PluginContext, PluginExtensions, CommandContext, CommandIntents, MergePluginExtensions, RedemeinePlugin, ReadonlyDeep } from '@redemeine/kernel';
import { MixinPackage } from './createMixin';
import { EntityPackage } from './createEntity';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './proxies/createEmitProxy';
import { createCommandCreatorsProxy } from './proxies/createCommandCreatorsProxy';
import { createCommandContextProxy } from './proxies/createCommandContextProxy';
import { RedemeineCommandDefinition, RedemeineEventDefinition, NormalizeEventDefinitions, GenericCommandFactory, GenericCommandMap, resolveCommandHandler, createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';
import { bindContext } from './bindContext';
import { applyEvent, applyEventToDraft } from './applyEvent';
import { defaultNamingStrategy } from './naming';
import type { Merge } from './types/Merge';
import type { AllKeys } from './types/AllKeys';
import type { EventEmitterFactory, MapCommandsToPayloads } from './types/aggregateTyping';

type AggregateSelectorUtils = { bindContext: typeof bindContext };

type AggregateSelector<S> =
    | ((state: ReadonlyDeep<S>, ...args: any[]) => any)
    | ((state: ReadonlyDeep<S>, utils: AggregateSelectorUtils, ...args: any[]) => any);

type AggregateSelectorsMap<S> = Record<string, AggregateSelector<S>>;

type UnionToIntersection<U> = (
    U extends unknown ? (arg: U) => void : never
) extends ((arg: infer I) => void)
    ? I
    : never;

// Extracts payloads from a single mixin
type AggregateMixinLike<S = any, Commands = {}, Registry extends AggregateEntityRegistry = {}> = {
    readonly __stateType?: S;
    commands?: Commands;
    events?: Record<string, Function>;
    projectors?: Record<string, Function>;
    eventMetadata?: Record<string, Record<string, unknown> | undefined>;
    eventOverrides?: Record<string, string>;
    commandOverrides?: Record<string, string>;
    selectors?: AggregateSelectorsMap<S>;
    commandFactory?: GenericCommandFactory;
    mounts?: Record<string, MountedStructureMetadata>;
    mountedEntities?: MountedEntityPackage[];
    __registryType?: Registry;
};

type ExtractMixinCommands<T> = T extends { commands?: infer CPayloads } ? CPayloads : {};
type MergeMixins<T extends any[]> = Merge<ExtractMixinCommands<T[number]> & {}>;
type ExtractMixinRegistry<T> = T extends { __registryType?: infer Registry } ? Registry : {};
type MergeMixinRegistries<T extends any[]> = Merge<ExtractMixinRegistry<T[number]> & {}>;
type ExtractMixinState<T> = T extends { __stateType?: infer MS } ? MS : never;
type CompatibleMixins<S, T extends AggregateMixinLike<any, any, any>[]> = {
    [K in keyof T]: S extends ExtractMixinState<T[K]> ? T[K] : never;
};

type MapEntityCommands<Name extends string, CPayloads> = {
    [K in keyof CPayloads as K extends string ? `${Name}${Capitalize<K>}` : never]: CPayloads[K]
};

type ExtractEntityCommands<T> = T extends EntityPackage<any, infer EName, any, any, infer CPayloads, any>
    ? MapEntityCommands<EName, CPayloads>
    : {};

type MergeEntities<T extends any[]> = Merge<ExtractEntityCommands<T[number]> & {}>;
type AggregateCommandKeys<T> = AllKeys<T & {}>;
type AggregateEventProjectorsMap<TEvents> = TEvents extends Record<string, (...args: any[]) => any>
    ? TEvents
    : Record<string, (...args: any[]) => any>;

type EntityMountOverrides = {
    eventNameOverrides?: Record<string, string>;
    commandNameOverrides?: Record<string, string>;
    /** @deprecated Use eventNameOverrides */
    eventOverrides?: Record<string, string>;
    /** @deprecated Use commandNameOverrides */
    commandOverrides?: Record<string, string>;
};

type EntityListOptions<PK extends string | readonly string[] = string | readonly string[]> = {
    pk?: PK;
};

type EntityMapOptions<K extends string = string> = {
    knownKeys?: readonly K[];
};

type MountedStructureKind = 'list' | 'map' | 'valueObject' | 'valueObjectList' | 'valueObjectMap';

export type MountedStructureMetadata = {
    kind: MountedStructureKind;
    commandPrefix: string;
    statePath: string[];
    pk?: string | readonly string[];
    knownKeys?: readonly string[];
};

type MountedEntityPackage = {
    name: string;
    kind: MountedStructureKind;
    component?: EntityPackage<unknown, string>;
    mountOverrides?: EntityMountOverrides;
    pk?: string | readonly string[];
    knownKeys?: readonly string[];
};

type EntityRegistryListEntry<T extends EntityPackage<any, any, any, any, any, any>, PK extends string | readonly string[]> = {
    kind: 'list';
    entity: T;
    pk: PK;
};

type EntityRegistryMapEntry<T extends EntityPackage<any, any, any, any, any, any>, Keys extends string = string> = {
    kind: 'map';
    entity: T;
    knownKeys?: readonly Keys[];
};

type EntityRegistryValueObjectEntry = {
    kind: 'valueObject';
};

type EntityRegistryValueObjectListEntry = {
    kind: 'valueObjectList';
};

type EntityRegistryValueObjectMapEntry = {
    kind: 'valueObjectMap';
};

export type AggregateEntityRegistry = Record<string, EntityRegistryListEntry<EntityPackage<any, any, any, any, any, any>, string | readonly string[]> | EntityRegistryMapEntry<EntityPackage<any, any, any, any, any, any>, string> | EntityRegistryValueObjectEntry | EntityRegistryValueObjectListEntry | EntityRegistryValueObjectMapEntry>;

type RegistryFromNamedEntities<EN extends Record<string, any>> = {
    [K in keyof EN as EN[K] extends EntityPackage<any, any, any, any, any, any> ? K : never]: EntityRegistryListEntry<Extract<EN[K], EntityPackage<any, any, any, any, any, any>>, 'id'>;
};

type RegistryFromPackages<T extends readonly EntityPackage<any, any, any, any, any, any>[]> = UnionToIntersection<
    T[number] extends infer P
        ? P extends EntityPackage<any, infer PName, any, any, any, any>
            ? { [K in PName]: EntityRegistryListEntry<P, 'id'> }
            : {}
        : {}
>;

/**
 * The core builder interface for composing Aggregates in Redemeine.
 * Uses a fluent chained API to progressively layer events, commands, mixins, and entities.
 */
export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}, Sel = {}, Registry extends AggregateEntityRegistry = {}, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}> {
    /**
     * Inherit all business rules, selectors, and events from a parent aggregate builder.
     * 
     * @example
     * const Shipment = createAggregate('Shipment', initialShipment)
     *   .extends(OrderAggregate) // Inherits standard order rules while adding legs
     */
    extends: <ParentM, ParentE, ParentEOverrides, ParentSel, ParentRegistry extends AggregateEntityRegistry>(
        parentBuilder: AggregateBuilder<S, any, ParentM, ParentE, ParentEOverrides, ParentSel, ParentRegistry, TMeta, TPlugins>
    ) => AggregateBuilder<S, Name, M & ParentM, E & ParentE, EOverrides & ParentEOverrides, Sel & ParentSel, Registry & ParentRegistry, TMeta, TPlugins>;

    /**
     * Register nested entities into the aggregate's namespace.
     * Entities keep their own private selectors and logic.
     * The naming engine will automatically map nested calls to targeted dot-notation commands (e.g. `order.order_lines.cancel.command`).
     * 
     * In the Mirage, mapped entities represent Immutable Hybrid Entity Collections: 
     * They act as a safe read-only array (e.g., iterating or calculating length) 
     * and as a command factory function (passing the entity ID).
     *
     * @example
     * .entities({ orderLines: OrderLineEntity })
     * 
     * // Iterator access
     * const total = mirage.orderLines.length;
     * 
     * // Command mapping by Entity ID
    * mirage.orderLines('line-1').cancel()
     */
    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides, Sel, Registry & RegistryFromNamedEntities<EN> & RegistryFromPackages<T>, TMeta, TPlugins>;

    /**
     * Register a list-backed entity collection with optional simple or composite primary key definition.
     */
    entityList: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>, const PK extends string | readonly string[] = 'id'>(
        name: EN,
        entityComponent: T,
        options?: EntityListOptions<PK>,
        mountOverrides?: EntityMountOverrides
    ) => AggregateBuilder<S, Name, M & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer CPayloads, any> ? CPayloads : {}>, E, EOverrides, Sel, Registry & { [K in EN]: EntityRegistryListEntry<T, PK> }, TMeta, TPlugins>;

    /**
     * Register a record-backed entity map with optional known keys.
     */
    entityMap: <EN extends string, Keys extends string, T extends EntityPackage<any, any, any, any, any, any>>(
        name: EN,
        entityComponent: T,
        options?: EntityMapOptions<Keys>,
        mountOverrides?: EntityMountOverrides
    ) => AggregateBuilder<S, Name, M & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer CPayloads, any> ? CPayloads : {}>, E, EOverrides, Sel, Registry & { [K in EN]: EntityRegistryMapEntry<T, Keys> }, TMeta, TPlugins>;

    /**
     * Register a value object branch. It is exposed as read-only state and does not add routed commands.
     */
    valueObject: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectEntry }, TMeta, TPlugins>;

    /**
     * Register a read-only value object list branch.
     * Unlike entities, this branch does not route nested commands.
     */
    valueObjectList: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectListEntry }, TMeta, TPlugins>;

    /**
     * Register a read-only value object map branch.
     * Unlike entities, this branch does not route nested commands.
     */
    valueObjectMap: <VOName extends string>(
        name: VOName,
        schema?: unknown
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry & { [K in VOName]: EntityRegistryValueObjectMapEntry }, TMeta, TPlugins>;

    /**
     * Compose reusable domain logic chunks (Mixins) into this aggregate.
     * 
     * @example
     * .mixins(TrackingMixin, AuditLoggerMixin)
     */
    mixins: <T extends AggregateMixinLike<any, any, any>[]>(
        ...mixins: CompatibleMixins<S, T>
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>, E, EOverrides, Sel, Registry & MergeMixinRegistries<T>, TMeta, TPlugins>;

    /**
     * Register aggregate-level plugins to be composed into Mirage/Depot runtime behavior.
     */
    plugins: <P extends RedemeinePlugin<any>[]>(
        ...plugins: P
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins & MergePluginExtensions<P>>;

    /**
     * Define pure functions for reading and deriving state.
     * These will be injectable into your command handlers via the `context` parameter.
     * 
     * @example
     * .selectors({
     *   getTotalWeight: (state) => state.items.reduce((sum, item) => sum + item.weight, 0)
     * })
     */
    selectors: {
        <NewSel extends AggregateSelectorsMap<S>>(
            selectors: NewSel
        ): AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel, Registry, TMeta, TPlugins>;
        <NewSel extends AggregateSelectorsMap<S>>(
            selectorFactory: (utils: AggregateSelectorUtils) => NewSel
        ): AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel, Registry, TMeta, TPlugins>;
    };

    /**
     * Register state-altering event handlers.
     * **Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
     * The auto-namer maps camelCase keys to dot notation (e.g. `itemAdded` -> `aggregate.item_added.event`).
     * 
     * @example
     * .events({
     *   itemAdded: (state, event) => { state.items.push(event.payload); }
     * })
     */
    events: <NewE extends Record<string, RedemeineEventDefinition<S, TMeta>>>(
        events: NewE
    ) => AggregateBuilder<S, Name, M, E & NormalizeEventDefinitions<NewE>, EOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Overrides the default Targeted Naming engine for specific events.
     * Crucial for legacy migrations where historical event strings do not match the standard `aggregate.entity.action` convention.
     * 
     * @example
     * .overrideEventNames({ orderAccepted: 'LEGACY_ORDER_ACCEPTED_V1' })
     */
    overrideEventNames: <NewEOverrides extends Partial<Record<string, EventType>>>(
        overrides: NewEOverrides
    ) => AggregateBuilder<S, Name, M, E, EOverrides & NewEOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Replaces the default Targeted Naming engine with a custom strategy.
     * Use this if your entire system uses a different naming convention (e.g., camelCase instead of dot-notation).
     * 
     * @example
     * .naming({ event: (agg, prop) => `${agg}_${prop}` })
     */
    naming: (strategy: Partial<NamingStrategy>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Define command processors that execute business logic and emit events.
     * **Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands, only within `.events()`.
     * The auto-namer evaluates camelCase keys (e.g. `dispatchShipment` -> `aggregate.dispatch_shipment.command`).
     * 
     * @example
     * .commands((emit, ctx) => ({
     *   dispatchShipment: (state, payload: { dest: string }) => {
     *     if (ctx.selectors.isReady(state)) return emit('dispatched', payload);
     *     throw new Error("Not ready");
     *   },
     *   legacyUpdate: {
     *     pack: (id: string, street: string) => ({ addressId: id, street }),
     *     handler: (state, payload) => emit('updated', payload)
     *   }
     * }))
     */
commands: <C extends Record<string, RedemeineCommandDefinition<S, TMeta, TPlugins>>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>, context: { selectors: Sel; commands: CommandContext<CommandIntents<M>>; plugins?: PluginContext<TPlugins> }) => C
    ) => AggregateBuilder<S, Name, M & MapCommandsToPayloads<C>, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Overrides the default Targeted Naming engine for specific commands.
     * Prevents the auto-namer from modifying the key into standard dot-notation routing.
     * 
     * @example
     * .overrideCommandNames({ cancelOrder: 'cmd.legacy.cancel' })
     */
    overrideCommandNames: (overrides: Partial<Record<AggregateCommandKeys<M>, CommandType>>) => 
        AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Registers lifecycle hooks for cross-cutting concerns (e.g., logging, auth, metrics).
     * Hooks intercept the execution flow but DO NOT mutate state directly.
     * @example
     * .hooks({
     *   onBeforeCommand: (cmd, state) => {
     *     if (cmd.metadata?.userId !== state.ownerId) throw new Error("Unauthorized");
     *   },
     *   onEventApplied: (event, state) => console.log(`State updated to ${state.status}`)
     * })
     */
    hooks: (hooks: AggregateHooks<S>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel, Registry, TMeta, TPlugins>;

    /**
     * Finalizes and compiles the aggregate.
     */
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
        /** The raw, un-routed domain functions. STRICTLY FOR ISOLATED UNIT TESTING. Do not use these to bypass the Mirage dispatch loop in production as it will skip lifecycle hooks. */
        pure: {
            commandProcessors: Record<string, Function>;
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

    // Internal state for inheritance
    _state: {
        events: Record<string, Function>;
        eventMetadata: Record<string, Record<string, unknown> | undefined>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        commandsFactory: GenericCommandFactory;
        mixins: AggregateMixinLike<S>[];
        selectors: Record<string, Function>;
        hooks: AggregateHooks<S>;
        plugins: RedemeinePlugin<TPlugins>[];
    };
}

/**
 * Bootstraps a new Redemeine Domain Aggregate Composer.
 *
 * @example
 * const Order = createAggregate('order', initialState)
 *   .mixins(Contactable, Identifiable)
 *   .commands((emit) => ({
 *     registerContact: {
 *       pack: (name: string, email: string) => ({ name, email }),
 *       handler: (state, payload) => emit.contactRegistered(payload)
 *     }
 *   }))
 */
export function createAggregate<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}>(
    aggregateName: Name,
    initialState: S
): AggregateBuilder<S, Name, {}, {}, {}, {}, {}, TMeta, TPlugins> {

    const component = createComponentBehaviorState<S>();
    let _entityPackages: MountedEntityPackage[] = [];
    let _mixins: AggregateMixinLike<any>[] = [];
    let _namingStrategy: NamingStrategy = defaultNamingStrategy;
    let _hooks: AggregateHooks<S> = {};
    let _plugins: RedemeinePlugin<any>[] = [];

    const builder = bindFluentMethods({}, {
        selectors: (selectorsOrFactory: AggregateSelectorsMap<S> | ((utils: AggregateSelectorUtils) => AggregateSelectorsMap<S>)) => {
            const resolvedSelectors = typeof selectorsOrFactory === 'function'
                ? selectorsOrFactory({ bindContext })
                : selectorsOrFactory;
            component.addSelectors(resolvedSelectors);
        },
        events: (events: Record<string, RedemeineEventDefinition<S, TMeta>>) => component.addEvents(events as Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>),
        overrideEventNames: (overrides: Record<string, string>) => component.addEventOverrides(overrides),
        commands: (factory: GenericCommandFactory) => component.addCommandsFactory(factory),
        overrideCommandNames: (overrides: Record<string, string>) => component.addCommandOverrides(overrides)
    });

    Object.assign(builder, {
        extends: (parentBuilder: AggregateBuilder<S, string, unknown, unknown, unknown, unknown, AggregateEntityRegistry, TMeta, TPlugins>) => {
            const parentState = parentBuilder._state;
            component.inherit(parentState);
            _hooks = { ...parentState.hooks, ..._hooks };
            _plugins = [...parentState.plugins, ..._plugins];
            _mixins = [...parentState.mixins, ..._mixins];
            const inheritedMounted = (parentState.mixins as any[])
                .flatMap((m) => Array.isArray(m?.mountedEntities) ? m.mountedEntities : []);
            if (inheritedMounted.length > 0) {
                _entityPackages.push(...inheritedMounted as MountedEntityPackage[]);
            }
            return builder;
        },

        entities: (entitiesObj: Record<string, unknown> | undefined, ...packages: EntityPackage<unknown, string>[]) => {
            if (entitiesObj && typeof entitiesObj === 'object') {
                Object.entries(entitiesObj).forEach(([name, entityComponent]) => {
                    if (entityComponent && typeof entityComponent === 'object') {
                        _entityPackages.push({
                            name,
                            kind: 'list',
                            component: entityComponent as EntityPackage<unknown, string>,
                            pk: 'id'
                        });
                    }
                });
            }
            if (packages.length > 0) {
                _entityPackages.push(...packages.map((pkg) => ({
                    name: pkg.name,
                    kind: 'list' as const,
                    component: pkg,
                    pk: 'id'
                })));
            }
            return builder;
        },

        entityList: <const PK extends string | readonly string[]>(name: string, entityComponent: EntityPackage<unknown, string>, options?: EntityListOptions<PK>, mountOverrides?: EntityMountOverrides) => {
            _entityPackages.push({ name, kind: 'list', component: entityComponent, mountOverrides, pk: options?.pk || 'id' });
            return builder;
        },

        entityMap: (name: string, entityComponent: EntityPackage<unknown, string>, options?: EntityMapOptions, mountOverrides?: EntityMountOverrides) => {
            _entityPackages.push({ name, kind: 'map', component: entityComponent, mountOverrides, knownKeys: options?.knownKeys });
            return builder;
        },

        valueObject: (name: string) => {
            _entityPackages.push({ name, kind: 'valueObject' });
            return builder;
        },

        valueObjectList: (name: string) => {
            _entityPackages.push({ name, kind: 'valueObjectList' });
            return builder;
        },

        valueObjectMap: (name: string) => {
            _entityPackages.push({ name, kind: 'valueObjectMap' });
            return builder;
        },

        mixins: (...mixins: AggregateMixinLike<any>[]) => {
            _mixins.push(...mixins);
            const mountedFromMixins = (mixins as any[])
                .flatMap((m) => Array.isArray(m?.mountedEntities) ? m.mountedEntities : []);
            if (mountedFromMixins.length > 0) {
                _entityPackages.push(...mountedFromMixins as MountedEntityPackage[]);
            }
            return builder;
        },

        plugins: (...plugins: RedemeinePlugin<any>[]) => {
            _plugins.push(...plugins);
            return builder;
        },

        naming: (strategy: Partial<NamingStrategy>) => {
            _namingStrategy = { ..._namingStrategy, ...strategy };
            return builder;
        },

        hooks: (hooks: AggregateHooks<S>) => {
            _hooks = { ..._hooks, ...hooks };
            return builder;
        },

        get _state() {
            const snapshot = component.getSnapshot();
            return {
                events: snapshot.events,
                eventMetadata: snapshot.eventMetadata,
                eventOverrides: snapshot.eventOverrides,
                commandOverrides: snapshot.commandOverrides,
                commandsFactory: component.getCommandsFactory(),
                mixins: _mixins,
                selectors: snapshot.selectors,
                hooks: _hooks,
                plugins: _plugins as RedemeinePlugin<TPlugins>[]
            };
        },

        build: () => {
            const snapshot = component.getSnapshot();
            const allEvents = _mixins.reduce((acc, m) => ({ ...acc, ...(m.projectors || m.events) }), snapshot.events);
            const allEventMetadata: Record<string, TMeta | undefined> = {
                ...(snapshot.eventMetadata as Record<string, TMeta | undefined>)
            };
            _mixins.forEach((m) => {
                const mixinMeta = (m.eventMetadata || {}) as Record<string, TMeta | undefined>;
                Object.assign(allEventMetadata, mixinMeta);
            });
            const projectorByEventType: Record<string, Function> = {};
            const scopedProjectorByEventType: Record<string, Function> = {};
            const scopedEventProjectors: Record<string, Function> = {};
            const allEventOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...(m.eventOverrides || {}) }), snapshot.eventOverrides);
            const allCommandOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...(m.commandOverrides || {}) }), snapshot.commandOverrides);
            const allSelectors = _mixins.reduce((acc, m) => ({ ...acc, ...(m.selectors || {}) }), snapshot.selectors) as AggregateSelectorsMap<S>;
            const mounts: Record<string, MountedStructureMetadata> = {};

            const composeMountedType = (path: string, relativeName: string, suffix: 'event' | 'command') => {
                const expectedSuffix = `.${suffix}`;
                const normalized = relativeName.endsWith(expectedSuffix)
                    ? relativeName
                    : `${relativeName}${expectedSuffix}`;
                return `${aggregateName}.${path}.${normalized}`;
            };

            const emit = createEmitProxy(aggregateName, allEventOverrides, _namingStrategy);

            const allCommandsMap: GenericCommandMap = {
                ...component.getCommandsFactory()(emit, {
                    selectors: allSelectors,
                    commands: createCommandContextProxy<Record<string, unknown>>()
                }),
                ..._mixins.reduce((acc, m) => ({
                    ...acc,
                    ...(m.commandFactory ? m.commandFactory(emit, {
                        selectors: allSelectors,
                        commands: createCommandContextProxy<Record<string, unknown>>()
                    }) : {})
                }), {} as GenericCommandMap)
            };

            // 1. Assign dot-notation path based on collection name
            // 2. Prevent selector shadowing
            _entityPackages.forEach(({ name: mountName, kind, component: entity, mountOverrides, pk, knownKeys }) => {
                mounts[mountName] = {
                    kind,
                    commandPrefix: mountName,
                    statePath: [mountName],
                    pk,
                    knownKeys
                };

                if (!entity || kind === 'valueObject') {
                    return;
                }

                const collectionName = mountName + 's';
                const entityPath = collectionName.replace(/s$/, '').replace(/([A-Z])/g, '_$1').toLowerCase();
                const entityEvents = entity.projectors || entity.events || {};
                const entityEventMetadata = (entity as unknown as { eventMetadata?: Record<string, TMeta | undefined> }).eventMetadata || {};
                const entityEventNameOverrides = entity.eventOverrides || {};
                const mountEventNameOverrides = {
                    ...((mountOverrides && mountOverrides.eventOverrides) || {}),
                    ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
                };

                Object.assign(allEvents, entityEvents);

                Object.keys(entityEvents).forEach((eventKey) => {
                    scopedEventProjectors[`${entityPath}:${eventKey}`] = entityEvents[eventKey];
                    allEventMetadata[`${entityPath}:${eventKey}`] = entityEventMetadata[eventKey];
                    const mountEventOverride = (mountEventNameOverrides as Record<string, string>)[eventKey];
                    const entityEventOverride = (entityEventNameOverrides as Record<string, string>)[eventKey];
                    const scopedEventType = mountEventOverride
                        || (entityEventOverride
                            ? composeMountedType(entityPath, entityEventOverride, 'event')
                            : _namingStrategy.event(aggregateName, eventKey, entityPath));
                    allEventOverrides[`${entityPath}:${eventKey}`] = scopedEventType;
                    projectorByEventType[scopedEventType] = entityEvents[eventKey];
                    scopedProjectorByEventType[scopedEventType] = entityEvents[eventKey];
                });

                const entitySelectors = entity.selectors || {};
                
                // Selector Shadowing Prevention
                const mergedSelectors = new Proxy({ ...entitySelectors, root: allSelectors }, {
                    get: (target: Record<string, unknown>, prop: string) => {
                        if (prop in entitySelectors && prop in allSelectors && prop !== 'root') {
                            console.warn(`[Selector Shadowing]: entity "${mountName}" and root both define "${prop}". Use "selectors.root.${prop}" to access the root selector.`);
                        }
                        if (prop in target) return target[prop as keyof typeof target];
                        return allSelectors[prop as keyof typeof allSelectors];
                    }
                });

                const entityEmit = createEmitProxy(aggregateName, allEventOverrides, _namingStrategy, entityPath);
                const entityCommands = entity.commandFactory(entityEmit, {
                    selectors: mergedSelectors,
                    commands: createCommandContextProxy<Record<string, unknown>>()
                });
                const entityCommandNameOverrides = entity.commandOverrides || {};
                const mountCommandNameOverrides = {
                    ...((mountOverrides && mountOverrides.commandOverrides) || {}),
                    ...((mountOverrides && mountOverrides.commandNameOverrides) || {})
                };
                
                // Flatten the commands with the entity name mapping into the global pool for processing
                Object.keys(entityCommands).forEach(cmdProp => {
                    const mappedCmd = mountName + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
                    allCommandsMap[mappedCmd] = entityCommands[cmdProp];
                    const mountCommandOverride = (mountCommandNameOverrides as Record<string, string>)[cmdProp];
                    const entityCommandOverride = (entityCommandNameOverrides as Record<string, string>)[cmdProp];
                    if (mountCommandOverride) {
                        allCommandOverrides[mappedCmd] = mountCommandOverride;
                    } else if (entityCommandOverride) {
                        allCommandOverrides[mappedCmd] = composeMountedType(entityPath, entityCommandOverride, 'command');
                    }
                });
            });

            Object.keys(allEvents).forEach((eventKey) => {
                const resolvedEventType = allEventOverrides[eventKey] || _namingStrategy.event(aggregateName, eventKey);
                if (!(resolvedEventType in projectorByEventType)) {
                    projectorByEventType[resolvedEventType] = allEvents[eventKey];
                }
            });

            const metadataByEventType = Array.from(new Set([...Object.keys(allEvents), ...Object.keys(allEventMetadata)])).reduce((acc, eventKey) => {
                const resolvedEventType = allEventOverrides[eventKey] || _namingStrategy.event(aggregateName, eventKey);
                const meta = allEventMetadata[eventKey];
                acc[resolvedEventType] = meta !== undefined ? { meta } : {};
                return acc;
            }, {} as Record<string, { meta?: TMeta }>);

            const metadataByCommandType = Object.keys(allCommandsMap).reduce((acc, key) => {
                const resolvedCommandType = allCommandOverrides[key] || _namingStrategy.command(aggregateName, key);
                const commandDefinition = allCommandsMap[key] as unknown as { meta?: TMeta };
                const meta = commandDefinition?.meta;
                acc[resolvedCommandType] = meta !== undefined ? { meta } : {};
                return acc;
            }, {} as Record<string, { meta?: TMeta }>);

            const commandHandlerByType = Object.keys(allCommandsMap).reduce((acc, key) => {
                const resolvedCommandType = allCommandOverrides[key] || _namingStrategy.command(aggregateName, key);
                acc[resolvedCommandType] = resolveCommandHandler<S>(allCommandsMap[key]) as unknown as (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[];
                return acc;
            }, {} as Record<string, (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[]>);

            const commandTypesByKey = Object.keys(allCommandsMap).reduce((acc, key) => {
                acc[key] = allCommandOverrides[key] || _namingStrategy.command(aggregateName, key);
                return acc;
            }, {} as Record<string, string>);

            const eventTypesByKey = Object.keys(allEvents).reduce((acc, key) => {
                acc[key] = allEventOverrides[key] || _namingStrategy.event(aggregateName, key);
                return acc;
            }, {} as Record<string, string>);

            return {
                aggregateType: aggregateName,
                initialState,
                process: createCommandProcessor<S>(aggregateName, allCommandsMap, allCommandOverrides, commandHandlerByType),
                apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides, projectorByEventType, scopedProjectorByEventType, scopedEventProjectors),
                applyToDraft: (draft: S, event: Event): void => {
                    applyEventToDraft(aggregateName, draft, event, allEvents, allEventOverrides, projectorByEventType, scopedProjectorByEventType, scopedEventProjectors);
                },
                commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap, allCommandOverrides, _namingStrategy),
                eventCreators: emit,
                pure: {
                    commandProcessors: allCommandsMap as unknown as Record<string, Function>,
                    eventProjectors: allEvents
                },
                selectors: allSelectors,
                hooks: _hooks,
                mounts,
                metadata: {
                    commands: metadataByCommandType,
                    events: metadataByEventType
                },
                types: {
                    commands: commandTypesByKey,
                    events: eventTypesByKey
                },
                plugins: _plugins as RedemeinePlugin<TPlugins>[]
            };
        }
    });

    return builder as unknown as AggregateBuilder<S, Name, {}, {}, {}, {}, {}, TMeta, TPlugins>;
}
