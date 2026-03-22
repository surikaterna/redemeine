import { Event, Command, EventEmitterFactory, EventType, CommandType, NamingStrategy, SelectorsMap } from './types';
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

export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}, Sel = {}> {
    extends: <ParentM, ParentE, ParentEOverrides, ParentSel>(
        parentBuilder: AggregateBuilder<S, any, ParentM, ParentE, ParentEOverrides, ParentSel>
    ) => AggregateBuilder<S, Name, M & ParentM, E & ParentE, EOverrides & ParentEOverrides, Sel & ParentSel>;

    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides, Sel>;

    mixins: <T extends MixinPackage<S, any, any, any, any, any>[]>(
        ...mixins: T
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>, E, EOverrides, Sel>;

    selectors: <NewSel extends SelectorsMap<S>>(
        selectors: NewSel
    ) => AggregateBuilder<S, Name, M, E, EOverrides, Sel & NewSel>;

    events: <NewE extends Record<string, (state: any, event: Event<any, any>) => void>>(
        events: NewE
    ) => AggregateBuilder<S, Name, M, E & NewE, EOverrides, Sel>;

    overrideEventNames: <NewEOverrides extends Partial<Record<string, EventType>>>(
        overrides: NewEOverrides
    ) => AggregateBuilder<S, Name, M, E, EOverrides & NewEOverrides, Sel>;

    naming: (strategy: Partial<NamingStrategy>) => AggregateBuilder<S, Name, M, E, EOverrides, Sel>;

    commands: <C extends Record<string, (state: ReadonlyDeep<S>, payload: any) => Event<any, any> | Event<any, any>[]>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>, context: { selectors: Sel }) => C
    ) => AggregateBuilder<S, Name, M & { [K in keyof C]: Parameters<C[K]>[1] }, E, EOverrides, Sel>;

    overrideCommandNames: (overrides: Partial<Record<keyof M, CommandType>>) => 
        AggregateBuilder<S, Name, M, E, EOverrides, Sel>;

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
    };
    
    // Internal state for inheritance
    _state: {
        events: Record<string, Function>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        commandsFactory: (emit: any, context: { selectors: any }) => Record<string, Function>;
        mixins: MixinPackage<S>[];
        selectors: Record<string, Function>;
    };
}

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

    const builder: any = {
        extends: (parentBuilder: any) => {
            const parentState = parentBuilder._state;
            _events = { ...parentState.events, ..._events };
            _eventOverrides = { ...parentState.eventOverrides, ..._eventOverrides };
            _commandOverrides = { ...parentState.commandOverrides, ..._commandOverrides };
            _selectors = { ...parentState.selectors, ..._selectors };
            
            const existingFactory = _commandsFactory;
            _commandsFactory = (emit: any, context: { selectors: any }) => ({
                ...parentState.commandsFactory(emit, context),
                ...existingFactory(emit, context)
            });
            
            _mixins = [...parentState.mixins, ..._mixins];
            return builder;
        },

        entities: (entitiesObj: any, ...packages: EntityPackage<any, any>[]) => {
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

        get _state() {
            return {
                events: _events,
                eventOverrides: _eventOverrides,
                commandOverrides: _commandOverrides,
                commandsFactory: _commandsFactory,
                mixins: _mixins,
                selectors: _selectors
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
                selectors: allSelectors
            };
        }
    };

    return builder;
}
