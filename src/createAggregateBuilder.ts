import { Event, Command, EventEmitterFactory, EventType, CommandType } from './types';
import { MixinPackage } from './createMixin';
import { EntityPackage } from './createEntity';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { applyEvent } from './applyEvent';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './createEmitProxy';
import { createCommandCreatorsProxy } from './createCommandCreatorsProxy';

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
        initialState: S;
        process: (state: S, command: Command<any, string>) => Event[];
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

            const emit = createEmitProxy(aggregateName, allEventOverrides);

            const coreCommands = _commandsFactory(emit);
            const allCommandsMap = _mixins.reduce((acc, m) => ({
                ...acc,
                ...m.commandFactory(emit)
            }), coreCommands);

            return {
                initialState,
                process: createCommandProcessor<S>(aggregateName, allCommandsMap, allCommandOverrides),
                apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides),
                commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap, allCommandOverrides) as any
            };
        }
    };

    return builder;
}
