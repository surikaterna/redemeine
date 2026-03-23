import { Event, Command, EventEmitterFactory, EventType, CommandType, NamingStrategy, SelectorsMap, AggregateHooks, MapCommandsToPayloads } from './types';
import { MixinPackage } from './createMixin';
import { EntityPackage } from './createEntity';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { Merge } from './utils/types/Merge';
import { AllKeys } from './utils/types/AllKeys';
import { applyEvent } from './utils/applyEvent';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './proxies/createEmitProxy';
import { createCommandCreatorsProxy } from './proxies/createCommandCreatorsProxy';
import { defaultNamingStrategy } from './utils/naming';
import { RedemeineCommandDefinition, createComponentBehaviorState } from './redemeineComponent';

// Extracts payloads from a single mixin
type ExtractMixinCommands<T> = T extends MixinPackage<any, any, any, infer CPayloads, any, any> ? CPayloads : {};
type MergeMixins<T extends any[]> = Merge<ExtractMixinCommands<T[number]> & {}>;

type MapEntityCommands<Name extends string, CPayloads> = {
    [K in keyof CPayloads as K extends string ? `${Name}${Capitalize<K>}` : never]: CPayloads[K]
};

type ExtractEntityCommands<T> = T extends EntityPackage<any, infer EName, any, any, infer CPayloads, any>
    ? MapEntityCommands<EName, CPayloads>
    : {};

type MergeEntities<T extends any[]> = Merge<ExtractEntityCommands<T[number]> & {}>;
type AggregateCommandKeys<T> = AllKeys<T & {}>;

/**
 * The core builder interface for composing Aggregates in Redemeine.
 * Uses a fluent chained API to progressively layer events, commands, mixins, and entities.
 */
export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}, Sel = {}> {
    /**
     * Inherit all business rules, selectors, and events from a parent aggregate builder.
     * 
     * @example
     * const Shipment = createAggregate('Shipment', initialShipment)
     *   .extends(OrderAggregate) // Inherits standard order rules while adding legs
     */
    extends: <ParentM, ParentE, ParentEOverrides, ParentSel>(
        parentBuilder: AggregateBuilder<S, any, ParentM, ParentE, ParentEOverrides, ParentSel>
    ) => AggregateBuilder<S, Name, M & ParentM, E & ParentE, EOverrides & ParentEOverrides, Sel & ParentSel>;

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
     * await mirage.orderLines('line-1').cancel()
     */
    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides, Sel>;

    /**
     * Register a single entity component under a specific collection key.
     *
     * @example
     * .entity('orderLine', OrderLineEntity)
     */
    entity: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>>(
        name: EN,
        entityComponent: T
    ) => AggregateBuilder<S, Name, M & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer CPayloads, any> ? CPayloads : {}>, E, EOverrides, Sel>;

    /**
     * Compose reusable domain logic chunks (Mixins) into this aggregate.
     * 
     * @example
     * .mixins(TrackingMixin, AuditLoggerMixin)
     */
    mixins: <T extends MixinPackage<S, any, any, any, any, any>[]>(
        ...mixins: T
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>, E, EOverrides, Sel>;

    /**
     * Define pure functions for reading and deriving state.
     * These will be injectable into your command handlers via the `context` parameter.
     * 
     * @example
     * .selectors({
     *   getTotalWeight: (state) => state.items.reduce((sum, item) => sum + item.weight, 0)
     * })
     */
    selectors: <NewSel extends SelectorsMap<S>>(
        selectors: NewSel
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel>;

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
    events: <NewE extends Record<string, (state: any, event: Event<any, any>) => void>>(
        events: NewE
    ) => AggregateBuilder<S, Name, M, E & NewE, EOverrides, Sel>;

    /**
     * Overrides the default Targeted Naming engine for specific events.
     * Crucial for legacy migrations where historical event strings do not match the standard `aggregate.entity.action` convention.
     * 
     * @example
     * .overrideEventNames({ orderAccepted: 'LEGACY_ORDER_ACCEPTED_V1' })
     */
    overrideEventNames: <NewEOverrides extends Partial<Record<string, EventType>>>(
        overrides: NewEOverrides
    ) => AggregateBuilder<S, Name, M, E, EOverrides & NewEOverrides, Sel>;

    /**
     * Replaces the default Targeted Naming engine with a custom strategy.
     * Use this if your entire system uses a different naming convention (e.g., camelCase instead of dot-notation).
     * 
     * @example
     * .naming({ event: (agg, prop) => `${agg}_${prop}` })
     */
    naming: (strategy: Partial<NamingStrategy>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel>;

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
commands: <C extends Record<string, RedemeineCommandDefinition<S>>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>, context: { selectors: Sel }) => C
    ) => AggregateBuilder<S, Name, M & MapCommandsToPayloads<C>, E, EOverrides, Sel>;

    /**
     * Overrides the default Targeted Naming engine for specific commands.
     * Prevents the auto-namer from modifying the key into standard dot-notation routing.
     * 
     * @example
     * .overrideCommandNames({ cancelOrder: 'cmd.legacy.cancel' })
     */
    overrideCommandNames: (overrides: Partial<Record<AggregateCommandKeys<M>, CommandType>>) => 
        AggregateBuilder<S, Name, M, E, EOverrides, Sel>;

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
    hooks: (hooks: AggregateHooks<S>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel>;

    /**
     * Finalizes and compiles the aggregate.
     */
    build: () => {
        initialState: S;
        process: (state: S, command: Command<any, string>) => Event[];
        apply: (state: S, event: Event) => S;
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
            commandProcessors: Record<string, any>;
            eventProjectors: Record<string, Function>;
        };
        selectors: Sel;
        hooks: AggregateHooks<S>;

    };

    // Internal state for inheritance
    _state: {
        events: Record<string, Function>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        commandsFactory: (emit: any, context: { selectors: any }) => Record<string, any>;
        mixins: MixinPackage<S>[];
        selectors: Record<string, Function>;
        hooks: AggregateHooks<S>;
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
export function createAggregate<S, Name extends string>(
    aggregateName: Name,
    initialState: S
): AggregateBuilder<S, Name> {

    const component = createComponentBehaviorState<S>();
    let _entityPackages: EntityPackage<any, any>[] = [];
    let _mixins: MixinPackage<S>[] = [];
    let _namingStrategy: NamingStrategy = defaultNamingStrategy;
    let _hooks: AggregateHooks<S> = {};

    const builder: any = {
        extends: (parentBuilder: any) => {
            const parentState = parentBuilder._state;
            component.inherit(parentState);
            _hooks = { ...parentState.hooks, ..._hooks };
            _mixins = [...parentState.mixins, ..._mixins];
            return builder;
        },

        entities: (entitiesObj: any, ...packages: EntityPackage<any, any>[]) => {
            if (entitiesObj && typeof entitiesObj === 'object') {
                Object.entries(entitiesObj).forEach(([name, entityComponent]) => {
                    if (entityComponent && typeof entityComponent === 'object') {
                        _entityPackages.push({ ...(entityComponent as EntityPackage<any, any>), name } as EntityPackage<any, any>);
                    }
                });
            }
            if (packages.length > 0) {
                _entityPackages.push(...packages);
            }
            return builder;
        },

        entity: (name: string, entityComponent: EntityPackage<any, any>) => {
            _entityPackages.push({ ...entityComponent, name } as EntityPackage<any, any>);
            return builder;
        },

        mixins: (...mixins: MixinPackage<S>[]) => {
            _mixins.push(...mixins);
            return builder;
        },

        selectors: (selectors: Record<string, Function>) => {
            component.addSelectors(selectors);
            return builder;
        },

        events: (events: Record<string, Function>) => {
            component.addEvents(events);
            return builder;
        },

        overrideEventNames: (overrides: Record<string, string>) => {
            component.addEventOverrides(overrides);
            return builder;
        },

        naming: (strategy: Partial<NamingStrategy>) => {
            _namingStrategy = { ..._namingStrategy, ...strategy };
            return builder;
        },

        commands: (factory: (emit: any, context: { selectors: any }) => Record<string, any>) => {
            component.addCommandsFactory(factory);
            return builder;
        },

        overrideCommandNames: (overrides: Record<string, string>) => {
            component.addCommandOverrides(overrides);
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
                eventOverrides: snapshot.eventOverrides,
                commandOverrides: snapshot.commandOverrides,
                commandsFactory: component.getCommandsFactory(),
                mixins: _mixins,
                selectors: snapshot.selectors,
                hooks: _hooks
            };
        },

        build: () => {
            const snapshot = component.getSnapshot();
            const allEvents = _mixins.reduce((acc, m) => ({ ...acc, ...(m.projectors || m.events) }), snapshot.events);
            const allEventOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.eventOverrides }), snapshot.eventOverrides);
            const allCommandOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.commandOverrides }), snapshot.commandOverrides);
            const allSelectors = _mixins.reduce((acc, m) => ({ ...acc, ...(m.selectors || {}) }), snapshot.selectors) as SelectorsMap<S>;

            const emit = createEmitProxy(aggregateName, allEventOverrides, _namingStrategy);

            const allCommandsMap = {
                ...component.getCommandsFactory()(emit, { selectors: allSelectors }),
                ..._mixins.reduce((acc, m) => ({
                    ...acc,
                    ...m.commandFactory(emit, { selectors: allSelectors })
                }), {})
            };

            // 1. Assign dot-notation path based on collection name
            // 2. Prevent selector shadowing
            _entityPackages.forEach(entity => {
                const collectionName = entity.name + 's';
                const entityPath = collectionName.replace(/s$/, '').replace(/([A-Z])/g, '_$1').toLowerCase();

                const entitySelectors = entity.selectors || {};
                
                // Selector Shadowing Prevention
                const mergedSelectors = new Proxy({ ...entitySelectors, root: allSelectors }, {
                    get: (target: any, prop: string) => {
                        if (prop in entitySelectors && prop in allSelectors && prop !== 'root') {
                            console.warn(`[Selector Shadowing]: entity "${entity.name}" and root both define "${prop}". Use "selectors.root.${prop}" to access the root selector.`);
                        }
                        if (prop in target) return target[prop];
                        return allSelectors[prop];
                    }
                });

                const entityCommands = entity.commandFactory(emit, { selectors: mergedSelectors });
                const entityCommandOverrides = entity.commandOverrides || {};
                
                // Flatten the commands with the entity name mapping into the global pool for processing
                Object.keys(entityCommands).forEach(cmdProp => {
                    const mappedCmd = entity.name + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
                    allCommandsMap[mappedCmd] = entityCommands[cmdProp];
                    if (entityCommandOverrides[cmdProp]) {
                        allCommandOverrides[mappedCmd] = entityCommandOverrides[cmdProp];
                    }
                });
            });

            return {
                initialState,
                process: createCommandProcessor<S>(aggregateName, allCommandsMap, allCommandOverrides),
                apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides),
                commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap, allCommandOverrides, _namingStrategy) as any,
                eventCreators: emit,
                pure: {
                    commandProcessors: allCommandsMap,
                    eventProjectors: allEvents
                },
                selectors: allSelectors,
                hooks: _hooks
            };
        }
    };

    return builder;
}
