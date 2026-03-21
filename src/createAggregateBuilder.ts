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


export interface AggregateBuilder<S, Name extends string, M = {}> {
    mixins: <T extends MixinPackage<S, any, any, any, any>[]>(
        ...mixins: T
    ) => AggregateBuilder<S, Name, M & MergeMixins<T>>;

    events: <E extends Record<string, (state: any, event: Event<any, any>) => void>>(
        events: E
    ) => AggregateBuilder<S, Name, M>;

    overrideEventNames: (overrides: Partial<Record<string, EventType>>) => AggregateBuilder<S, Name, M>;

    commands: <C extends Record<string, (state: ReadonlyDeep<S>, payload: any) => Event<any, any> | Event<any, any>[]>>(
        factory: (emit: EventEmitterFactory<Name, any, any>) => C
    ) => AggregateBuilder<S, Name, M & { [K in keyof C]: Parameters<C[K]>[1] }>;

    overrideCommandNames: (overrides: Partial<Record<keyof M, CommandType>>) => AggregateBuilder<S, Name, M>;

    build: () => {
        handle: (state: S, commandType: string, payload: any) => Event[];
        apply: (state: S, event: Event) => S;
        commandCreators: {
            [K in keyof M]: (payload: M[K]) => { type: string; payload: M[K] };
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
    const _mixins: MixinPackage<S>[] = [];

    const builder: any = {
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
                get: (_, prop: string) => (payload: any) => ({
                    type: allEventOverrides[prop] || `${aggregateName}.${prop}.event`,
                    payload
                })
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
                    return produce(state, (draft) => {
                        const eventKey = Object.keys(allEvents).find(key =>
                            (allEventOverrides[key] || `${aggregateName}.${key}.event`) === event.type
                        );
                        if (eventKey && allEvents[eventKey]) {
                            allEvents[eventKey](draft, event);
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