import type { NamingStrategy, AggregateHooks, PluginExtensions, RedemeinePlugin, Contract } from '@redemeine/kernel';
import type { EntityPackage } from './createEntity';
import type { RedemeineEventDefinition, GenericCommandFactory } from './redemeineComponent';
import { createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';
import { bindContext } from './bindContext';
import { defaultNamingStrategy } from './naming';
import { buildAggregate } from './buildAggregate';
import type {
    AggregateBuilder,
    AggregateMixinLike,
    AggregateSelectorsMap,
    AggregateSelectorUtils
} from './types/aggregate';
import type {
    MountedEntityPackage,
    EntityListOptions,
    EntityMapOptions,
    EntityMountOverrides
} from './types/entityMount';

// Re-export public API types
export type { MountedStructureMetadata, AggregateEntityRegistry, MountedStructureKind } from './types/entityMount';
export type { AggregateBuilder } from './types/aggregate';

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
/**
 * Handler invoked when an event has no matching projector in the aggregate.
 *
 * Use with `.onUnmatchedEvent()` to log, ignore, or throw on unknown events
 * during hydration.
 *
 * @since 0.2.0
 */
export type UnmatchedEventHandler = (eventType: string, aggregateName: string) => void;

/**
 * Creates a new aggregate builder with the fluent API pattern.
 *
 * An aggregate encapsulates domain state, commands, events, entities, and
 * validation. Chain builder methods to compose behavior, then call `.build()`
 * to produce the final compiled aggregate.
 *
 * @example
 * ```typescript
 * const Order = createAggregate('order', { items: [], status: 'draft' })
 *   .entities({ lineItems: LineItemEntity })
 *   .commands((emit) => ({
 *     place: (state, payload: { customerId: string }) => {
 *       return emit.orderPlaced(payload);
 *     }
 *   }))
 *   .events({
 *     orderPlaced: (state, { payload }) => { state.status = 'placed'; }
 *   })
 *   .build();
 * ```
 *
 * @param aggregateName - Unique name identifying this aggregate type
 * @param initialState - The default state for new aggregate instances
 * @returns A fluent builder for composing aggregate behavior
 * @since 0.1.0
 */
export function createAggregate<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>, TPlugins extends PluginExtensions = {}>(
    aggregateName: Name,
    initialState: S
): AggregateBuilder<S, Name, {}, {}, {}, {}, {}, TMeta, TPlugins> {

    const component = createComponentBehaviorState<S>();
    let _entityPackages: MountedEntityPackage[] = [];
    // SAFETY: `any` required — AggregateMixinLike's state param is covariant and mixins may have different state shapes
    let _mixins: AggregateMixinLike<any>[] = [];
    let _namingStrategy: NamingStrategy = defaultNamingStrategy;
    let _hooks: AggregateHooks<S> = {};
    // SAFETY: `any` required — RedemeinePlugin generic param must satisfy PluginExtensions constraint
    let _plugins: RedemeinePlugin<any>[] = [];
    let _unmatchedEventHandler: UnmatchedEventHandler | undefined;
    let _contract: Contract | undefined;

    const builder = bindFluentMethods({}, {
        selectors: (selectorsOrFactory: AggregateSelectorsMap<S> | ((utils: AggregateSelectorUtils) => AggregateSelectorsMap<S>)) => {
            const resolvedSelectors = typeof selectorsOrFactory === 'function'
                ? selectorsOrFactory({ bindContext })
                : selectorsOrFactory;
            component.addSelectors(resolvedSelectors);
        },
        events: (events: Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>) => component.addEvents(events),
        overrideEventNames: (overrides: Record<string, string>) => component.addEventOverrides(overrides),
        commands: (factory: GenericCommandFactory) => component.addCommandsFactory(factory),
        overrideCommandNames: (overrides: Record<string, string>) => component.addCommandOverrides(overrides)
    });

    Object.assign(builder, {
        // SAFETY: `any` in AggregateBuilder Registry position — parent registry type is erased at inheritance
        extends: (parentBuilder: AggregateBuilder<S, string, unknown, unknown, unknown, unknown, any, TMeta, TPlugins>) => {
            const parentState = parentBuilder._state;
            component.inherit(parentState);
            _hooks = { ...parentState.hooks, ..._hooks };
            _plugins = [...parentState.plugins, ..._plugins];
            _mixins = [...parentState.mixins, ..._mixins];
            // SAFETY: `unknown[]` — mixins array has heterogeneous state types from parent
            const inheritedMounted = (parentState.mixins as unknown as Array<{ mountedEntities?: unknown[] }>)
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

        // SAFETY: `any` required — mixins have heterogeneous state types
        mixins: (...mixins: AggregateMixinLike<any>[]) => {
            _mixins.push(...mixins);
            // SAFETY: `any[]` — mixins array has heterogeneous state types
            const mountedFromMixins = (mixins as unknown as Array<{ mountedEntities?: unknown[] }>)
                .flatMap((m) => Array.isArray(m?.mountedEntities) ? m.mountedEntities : []);
            if (mountedFromMixins.length > 0) {
                _entityPackages.push(...mountedFromMixins as MountedEntityPackage[]);
            }
            return builder;
        },

        // SAFETY: `any` required — PluginExtensions constraint
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

        onUnmatchedEvent: (handler: UnmatchedEventHandler) => {
            _unmatchedEventHandler = handler;
            return builder;
        },

        contract: (contract: Contract) => {
            _contract = contract;
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
            return buildAggregate<S, TMeta>({
                aggregateName,
                initialState,
                snapshot,
                commandsFactory: component.getCommandsFactory(),
                mixins: _mixins,
                entityPackages: _entityPackages,
                namingStrategy: _namingStrategy,
                hooks: _hooks,
                plugins: _plugins,
                ...(_unmatchedEventHandler ? { unmatchedEventHandler: _unmatchedEventHandler } : {}),
                ...(_contract ? { contract: _contract } : {})
            });
        }
    });

    return builder as unknown as AggregateBuilder<S, Name, {}, {}, {}, {}, {}, TMeta, TPlugins>;
}
