import { Event, Command, EventEmitterFactory, EventType, CommandType, NamingStrategy, SelectorsMap, AggregateHooks } from './types';
import { MixinPackage } from './createMixin';
import { EntityPackage } from './createEntity';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { applyEvent } from './applyEvent';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './createEmitProxy';
import { createCommandCreatorsProxy } from './createCommandCreatorsProxy';
import { defaultNamingStrategy } from './naming';

// Extracts payloads from a single mixin
type ExtractMixinCommands<T> = T extends MixinPackage<any, any, any, infer CPayloads, any, any> ? CPayloads : {};

// Recursively merges an array of mixins into a single Command map
type MergeMixins<T extends any[]> = T extends [infer First, ...infer Rest]
    ? ExtractMixinCommands<First> & MergeMixins<Rest>
    : {};

type ExtractEntityCommands<T> = T extends EntityPackage<any, infer EName, any, any, infer CPayloads, any>
    ? { [K in keyof CPayloads as K extends string ? `${EName}${Capitalize<K>}` : never]: CPayloads[K] }
    : {};

type MergeEntities<T extends any[]> = T extends [infer First, ...infer Rest]
    ? ExtractEntityCommands<First> & MergeEntities<Rest>
    : {};

/**
 * The core builder interface for composing Aggregates in Redemeine.
 * Uses a fluent chained API to progressively layer events, commands, mixins, and entities.
 */
export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}, Sel = {}> {
    /**
     * Inherit all business rules, selectors, and events from a parent aggregate builder.
     * 
     * @example
     * const Shipment = createAggregateBuilder('Shipment', initialShipment)
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
     * @example
     * .entities({ orderLines: OrderLineEntity }) 
     * // Later used as: order.orderLines('line-1').cancel()
     */
    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides, Sel>;

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
     *   }
     * }))
     */
    commands: <C extends Record<string, (state: ReadonlyDeep<S>, payload: any) => Event<any, any> | Event<any, any>[]>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>, context: { selectors: Sel }) => C
    ) => AggregateBuilder<S, Name, M & { [K in keyof C]: Parameters<C[K]>[1] }, E, EOverrides, Sel>;

    /**
     * Overrides the default Targeted Naming engine for specific commands.
     * Prevents the auto-namer from modifying the key into standard dot-notation routing.
     * 
     * @example
     * .overrideCommandNames({ cancelOrder: 'cmd.legacy.cancel' })
     */
    overrideCommandNames: (overrides: Partial<Record<keyof M, CommandType>>) => 
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
            [K in keyof M]: [M[K]] extends [void] | [undefined]
                ? () => { type: string; payload: void }
                : (payload: M[K]) => { type: string; payload: M[K] };
        };
        selectors: Sel;
        hooks: AggregateHooks<S>;
    };

    // Internal state for inheritance
    _state: {
        events: Record<string, Function>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        commandsFactory: (emit: any, context: { selectors: any }) => Record<string, Function>;
        mixins: MixinPackage<S>[];
        selectors: Record<string, Function>;
        hooks: AggregateHooks<S>;
    };
}

/**
 * Bootstraps a new Redemeine Domain Aggregate Composer.
 */
export function createAggregateBuilder<S, Name extends string>(
    aggregateName: Name,
    initialState: S
): AggregateBuilder<S, Name> {

    let _events: Record<string, Function> = {};
    let _eventOverrides: Record<string, string> = {};
    let _commandsFactory: (emit: any, context: { selectors: any }) => Record<string, Function> = () => ({});
    let _commandOverrides: Record<string, string> = {};
    let _entities: string[] = [];
    let _entityPackages: EntityPackage<any, any>[] = [];
    let _mixins: MixinPackage<S>[] = [];
    let _selectors: Record<string, Function> = {};
    let _namingStrategy: NamingStrategy = defaultNamingStrategy;
    let _hooks: AggregateHooks<S> = {};

    const builder: any = {
        extends: (parentBuilder: any) => {
            const parentState = parentBuilder._state;
            _events = { ...parentState.events, ..._events };
            _eventOverrides = { ...parentState.eventOverrides, ..._eventOverrides };
            _commandOverrides = { ...parentState.commandOverrides, ..._commandOverrides };
            _selectors = { ...parentState.selectors, ..._selectors };
            _hooks = { ...parentState.hooks, ..._hooks };

            const existingFactory = _commandsFactory;
            _commandsFactory = (emit, context) => ({
                ...parentState.commandsFactory(emit, context),
                ...existingFactory(emit, context)
            });
            if (packages.length > 0) {
                _entityPackages.push(...packages);
            }
            return builder;
        },

        mixins: (...mixins: MixinPackage<S>[]) => {
            _mixins.push(...mixins);
            return builder;
        },

        selectors: (selectors: Record<string, Function>) => {
            _selectors = { ..._selectors, ...selectors };
            return builder;
        },

        events: (events: Record<string, Function>) => {
            _events = { ..._events, ...events };
            return builder;
        },

        overrideEventNames: (overrides: Record<string, string>) => {
            _eventOverrides = { ..._eventOverrides, ...overrides };
            return builder;
        },

        naming: (strategy: Partial<NamingStrategy>) => {
            _namingStrategy = { ..._namingStrategy, ...strategy };
            return builder;
        },

        commands: (factory: (emit: any, context: { selectors: any }) => Record<string, Function>) => {
            _commandsFactory = factory;
            return builder;
        },

        overrideCommandNames: (overrides: Record<string, string>) => {
            _commandOverrides = { ..._commandOverrides, ...overrides };
            return builder;
        },

        hooks: (hooks: AggregateHooks<S>) => {
            _hooks = { ..._hooks, ...hooks };
            return builder;
        },

        get _state() {
            return {
                events: _events,
                eventOverrides: _eventOverrides,
                commandOverrides: _commandOverrides,
                commandsFactory: _commandsFactory,
                mixins: _mixins,
                selectors: _selectors,
                hooks: _hooks
            };
        },

        build: () => {
            const allEvents = _mixins.reduce((acc, m) => ({ ...acc, ...m.events }), _events);
            const allEventOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.eventOverrides }), _eventOverrides);
            const allCommandOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.commandOverrides }), _commandOverrides);
            const allSelectors = _mixins.reduce((acc, m) => ({ ...acc, ...(m.selectors || {}) }), _selectors) as SelectorsMap<S>;

            const emit = createEmitProxy(aggregateName, allEventOverrides, _namingStrategy);

            const coreCommands = _commandsFactory(emit, { selectors: allSelectors });
            let allCommandsMap = _mixins.reduce((acc, m) => ({
                ...acc,
                ...m.commandFactory(emit, { selectors: allSelectors })
            }), coreCommands);

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
                
                // Flatten the commands with the entity name mapping into the global pool for processing
                Object.keys(entityCommands).forEach(cmdProp => {
                    const mappedCmd = entity.name + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
                    allCommandsMap[mappedCmd] = entityCommands[cmdProp];
                });
            });

            return {
                initialState,
                process: createCommandProcessor<S>(aggregateName, allCommandsMap, allCommandOverrides),
                apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides),
                commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap, allCommandOverrides, _namingStrategy) as any,
                selectors: allSelectors,
                hooks: _hooks
            };
        }
    };

    return builder;
}
