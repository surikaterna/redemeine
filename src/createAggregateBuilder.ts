import { Event, EventEmitterFactory, EventType, CommandType } from './types';
import { MixinPackage } from './createMixin';
import { EntityPackage } from './createEntity';
import { produce, Draft } from 'immer';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// Extracts payloads from a single mixin
type ExtractMixinCommands<T> = T extends MixinPackage<any, any, any, infer CPayloads, any> ? CPayloads : {};

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

export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}> {
    entities: <EN extends Record<string, any> = {}, T extends EntityPackage<any, any, any, any, any, any>[] = []>(
        entities?: EN,
        ...entityPackages: T
    ) => AggregateBuilder<S, Name, M & MergeEntities<T>, E, EOverrides>;

    mixins: <T extends MixinPackage<S, any, any, any, any>[]>(
        ...mixins: T
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>, E, EOverrides>;

    events: <NewE extends Record<string, (state: any, event: Event<any, any>) => void>>(
        events: NewE
    ) => AggregateBuilder<S, Name, M, E & NewE, EOverrides>;

    overrideEventNames: <NewEOverrides extends Partial<Record<string, EventType>>>(
        overrides: NewEOverrides
    ) => AggregateBuilder<S, Name, M, E, EOverrides & NewEOverrides>;

    commands: <C extends Record<string, (state: ReadonlyDeep<S>, payload: any) => Event<any, any> | Event<any, any>[]>>(
        factory: (emit: EventEmitterFactory<Name, E, EOverrides>) => C
    ) => AggregateBuilder<S, Name, M & { [K in keyof C]: Parameters<C[K]>[1] }, E, EOverrides>;

    overrideCommandNames: (overrides: Partial<Record<keyof M, CommandType>>) => 
        AggregateBuilder<S, Name, M, E, EOverrides>;

    build: () => {
        handle: (state: S, commandType: string, payload: any) => Event[];
        apply: (state: S, event: Event) => S;
        commandCreators: {
            [K in keyof M]: [M[K]] extends [void] | [undefined]
                ? () => { type: string; payload: void }
                : (payload: M[K]) => { type: string; payload: M[K] };
        };
    };
}

export function createAggregateBuilder<S, Name extends string>(
    aggregateName: Name,
    initialState: S
): AggregateBuilder<S, Name> {

    let _events: Record<string, Function> = {};
    let _eventOverrides: Record<string, string> = {};
    let _commandsFactory: (emit: any) => Record<string, Function> = () => ({});
    let _commandOverrides: Record<string, string> = {};
    let _entities: string[] = [];
    let _entityPackages: EntityPackage<any, any>[] = [];
    const _mixins: MixinPackage<S>[] = [];

    const builder: any = {
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

        events: (events: Record<string, Function>) => {
            _events = events;
            return builder;
        },

        overrideEventNames: (overrides: Record<string, string>) => {
            _eventOverrides = overrides;
            return builder;
        },

        commands: (factory: (emit: any) => Record<string, Function>) => {
            _commandsFactory = factory;
            return builder;
        },

        overrideCommandNames: (overrides: Record<string, string>) => {
            _commandOverrides = overrides;
            return builder;
        },

        build: () => {
            const allEvents = _mixins.reduce((acc, m) => ({ ...acc, ...m.events }), _events);
            const allEventOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.eventOverrides }), _eventOverrides);
            const allCommandOverrides = _mixins.reduce((acc, m) => ({ ...acc, ...m.commandOverrides }), _commandOverrides);

            const emit = new Proxy({} as any, {
                get: (_, prop: string) => (...args: any[]) => {
                    let type = allEventOverrides[prop];
                    const payload = args.length > 0 ? args[0] : undefined;
                    
                    if (!type) {
                        const parts = prop.split(/(?=[A-Z])/);
                        if (parts.length > 1) {
                            const entities = parts.slice(0, parts.length - 1);
                            const action = parts[parts.length - 1];
                            const actionName = action.charAt(0).toLowerCase() + action.slice(1);
                            
                            const path = entities.map(e => e.toLowerCase()).join('.');
                            type = `${aggregateName}.${path}.${actionName}.event`;
                        } else {
                            type = `${aggregateName}.${prop}.event`;
                        }
                    }

                    return { type, payload };
                }
            });

            const coreCommands = _commandsFactory(emit);
            const allCommandsMap = _mixins.reduce((acc, m) => ({
                ...acc,
                ...m.commandFactory(emit)
            }), coreCommands);

            return {
                handle: (state: S, commandType: string, payload: any): Event[] => {
                    const commandKey = Object.keys(allCommandsMap).find(key =>
                        (allCommandOverrides[key] || `${aggregateName}.${key}.command`) === commandType
                    );

                    if (!commandKey) throw new Error(`Unknown command: ${commandType}`);

                    const result = allCommandsMap[commandKey](state as ReadonlyDeep<S>, payload);
                    return Array.isArray(result) ? result : [result];
                },

                apply: (state: S, event: Event): S => {
                    return produce(state, (draft: any) => {
                        let targetDraft = draft;
                        let eventTypeStr = event.type;
                        
                        // Parse targeted event: "aggregate.entity[id].subEntity[id2].eventName.event"
                        const prefix = aggregateName + '.';
                        let eventName = event.type;
                        
if (eventTypeStr.startsWith(prefix) && eventTypeStr.endsWith('.event')) {
                            const withoutSuffix = eventTypeStr.slice(0, -6); // remove .event
                            const parts = withoutSuffix.slice(prefix.length).split('.');
                            
                            if (parts.length > 1) {
                                const actionName = parts.pop()!;
                                
                                // Drill down
                                for (const part of parts) {
                                    const arrayName = part;
                                    // looking for ID from payload
                                    const id = event.payload && (
                                        event.payload[`${part}Id`] || 
                                        event.payload[`${part.slice(0, -1)}Id`] || 
                                        event.payload.id
                                    );
                                    
                                    if (id !== undefined) {
                                        if (Array.isArray(targetDraft[arrayName])) {
                                            const found = targetDraft[arrayName].find((item: any) => String(item.id) === String(id));
                                            if (found) {
                                                targetDraft = found;
                                            }
                                        } else if (Array.isArray(targetDraft[`${arrayName}s`])) {
                                            // Sometimes collection is plural
                                            const found = targetDraft[`${arrayName}s`].find((item: any) => String(item.id) === String(id));
                                            if (found) {
                                                targetDraft = found;
                                            }
                                        }
                                    }
                                }
                                
                                eventName = `${aggregateName}.${actionName}.event`;
                            }
                        }

                        const eventKey = Object.keys(allEvents).find(key =>
                            (allEventOverrides[key] || `${aggregateName}.${key}.event`) === eventName ||
                            (allEventOverrides[key] || `${aggregateName}.${key}.event`) === event.type // fallback
                        );
                        if (eventKey && allEvents[eventKey]) {
                            allEvents[eventKey](targetDraft, event);
                        }
                    }) as S;
                },

                commandCreators: new Proxy({} as any, {
                    get: (_, prop: string) => (payload: any) => ({
                        type: allCommandOverrides[prop] || `${aggregateName}.${prop}.command`,
                        payload
                    })
                })
            };
        }
    };

    return builder;
}
