import { Event, EventEmitterFactory, EventType, CommandType } from './types';
import { MixinPackage } from './createMixin';
import { produce, Draft } from 'immer';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// Extracts payloads from a single mixin
type ExtractMixinCommands<T> = T extends MixinPackage<any, any, any, infer CPayloads, any> ? CPayloads : {};

// Recursively merges an array of mixins into a single Command map
type MergeMixins<T extends any[]> = T extends [infer First, ...infer Rest]
    ? ExtractMixinCommands<First> & MergeMixins<Rest>
    : {};


export interface AggregateBuilder<S, Name extends string, M = {}, E = {}, EOverrides = {}> {
    entities: <EN extends Record<string, any>>(
        entities?: EN
    ) => AggregateBuilder<S, Name, M, E, EOverrides>;

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
    const _mixins: MixinPackage<S>[] = [];

    const builder: any = {
        entities: () => {
            // we don't strictly need runtime info if it just marks types, 
            // but we might need to store entity prefixes if we dynamically extract them in apply/commands
            // No, the proxy matches the strings. Actually, if we pass nothing, we can't get the keys.
            // Wait, if it's strictly a type level registration `.entities<T>()` with no args, we don't have runtime info. Let's assume we do string parsing instead.
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
                    if (!type) {
                        type = `${aggregateName}.${prop}.event`;
                        // Look for camelCase like entityNameEventName and format to entity[id].eventName.event
                        // But wait! We might have nested like order.line[123].subLine[456].updated.event. 
                        // How does `prop` look like? "lineUpdated", "subLineUpdated"? 
                        // The user said: "emit.lineUpdated('123', payload) => order.line[123].updated.event"
                    }
                    
                    // Simple logic: if args length > 1, the payload is last, rest are IDs
                    // If event name implies entity targeting, we rewrite the `type`.
                    const payload = args.length > 0 ? args[args.length - 1] : undefined;
                    const ids = args.length > 1 ? args.slice(0, args.length - 1) : [];
                    
                    if (ids.length > 0 && !allEventOverrides[prop]) {
                        // Very naive camelCase split, but properly supporting multiple IDs
                        // e.g. "lineSubLineUpdated", ids: ['123', 456] -> 'line[123].subLine[456].updated.event'
                        // we can chunk the prop string by capital letters if needed, but since we know ids.length,
                        // let's try to parse the exact number of entities.
                        // For simplicity, we just look at the prefix matching entities or split by CamelCase
                        const parts = prop.split(/(?=[A-Z])/);
                        if (parts.length >= ids.length + 1) {
                            const entities = parts.slice(0, ids.length);
                            const action = parts.slice(ids.length).join('');
                            const actionName = action.charAt(0).toLowerCase() + action.slice(1);
                            
                            const path = entities.map((e, i) => `${e.toLowerCase()}[${ids[i]}]`).join('.');
                            type = `${aggregateName}.${path}.${actionName}.event`;
                        } else {
                            // default fallback for 1 id
                            let match = prop.match(/^([a-z0-9A-Z]+?)([A-Z]\w+)$/);
                            if (match && ids.length === 1) {
                                const entityName = match[1];
                                const eventName = match[2].charAt(0).toLowerCase() + match[2].slice(1);
                                type = `${aggregateName}.${entityName}[${ids[0]}].${eventName}.event`;
                            }
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
                        
                        if (eventTypeStr.startsWith(prefix) && eventTypeStr.endsWith('.event') && eventTypeStr.includes('[')) {
                            const withoutSuffix = eventTypeStr.slice(0, -6); // remove .event
                            const parts = withoutSuffix.slice(prefix.length).split('.');
                            const actionName = parts.pop()!;
                            
                            // Drill down
                            for (const part of parts) {
                                const match = part.match(/^([a-zA-Z0-9_]+)\[(.*)\]$/);
                                if (match) {
                                    const arrayName = match[1];
                                    const id = match[2];
                                    if (Array.isArray(targetDraft[arrayName])) {
                                        const found = targetDraft[arrayName].find((item: any) => String(item.id) === id);
                                        if (found) {
                                            targetDraft = found;
                                        }
                                    } else if (Array.isArray(targetDraft[`${arrayName}s`])) {
                                        // Sometimes collection is plural
                                        const found = targetDraft[`${arrayName}s`].find((item: any) => String(item.id) === id);
                                        if (found) {
                                            targetDraft = found;
                                        }
                                    }
                                }
                            }
                            
                            eventName = `${aggregateName}.${actionName}.event`;
                            // We need the key to look up in allEvents.
                            // If the original registered event was "updated: () => {}", the lookup key is "updated"
                            // But usually the key is "updated" and the inferred type is "aggregate.updated.event".
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
