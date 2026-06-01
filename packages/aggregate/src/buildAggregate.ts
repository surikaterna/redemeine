import type { Event, NamingStrategy, AggregateHooks, RedemeinePlugin } from '@redemeine/kernel';
import type { MountedEntityPackage, MountedStructureMetadata } from './types/entityMount';
import type { AggregateMixinLike, AggregateSelectorsMap } from './types/aggregate';
import type { GenericCommandFactory, GenericCommandMap, AnyFunction, RedemeineCommandDefinition } from './redemeineComponent';
import { resolveCommandHandler } from './redemeineComponent';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './proxies/createEmitProxy';
import { createCommandCreatorsProxy } from './proxies/createCommandCreatorsProxy';
import { createCommandContextProxy } from './proxies/createCommandContextProxy';
import { applyEvent, applyEventToDraft } from './applyEvent';
import type { Draft } from 'immer';
import { resolveEvents, finalizeProjectorMap } from './build/resolveEvents';
import { mountEntities } from './build/mountEntities';
import type { ReadonlyDeep } from '@redemeine/kernel';

export type BuildAggregateInput<S, TMeta> = {
    aggregateName: string;
    initialState: S;
    snapshot: {
        events: Record<string, AnyFunction>;
        eventMetadata: Record<string, Record<string, unknown> | undefined>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        selectors: Record<string, AnyFunction>;
    };
    commandsFactory: GenericCommandFactory;
    mixins: AggregateMixinLike<S>[];
    entityPackages: MountedEntityPackage[];
    namingStrategy: NamingStrategy;
    hooks: AggregateHooks<S>;
    // SAFETY: `any` required — RedemeinePlugin is generic over PluginExtensions which has a constraint
    plugins: RedemeinePlugin<any>[];
};

/**
 * Orchestrates the full aggregate build: resolves events, commands, mounts entities,
 * and assembles the final aggregate object.
 */
export function buildAggregate<S, TMeta extends Record<string, unknown>>(input: BuildAggregateInput<S, TMeta>) {
    const { aggregateName, initialState, snapshot, commandsFactory, mixins, entityPackages, namingStrategy, hooks, plugins } = input;

    // 1. Resolve events from mixins
    const resolved = resolveEvents<S, TMeta>(snapshot, mixins, aggregateName, namingStrategy);
    const { allEvents, allEventMetadata, allEventOverrides, projectorByEventType, scopedProjectorByEventType, scopedEventProjectors } = resolved;

    // 2. Merge selectors and command overrides from mixins
    const allSelectors = mixins.reduce(
        (acc, m) => ({ ...acc, ...(m.selectors || {}) }),
        snapshot.selectors
    ) as AggregateSelectorsMap<S>;

    const allCommandOverrides = mixins.reduce(
        (acc, m) => ({ ...acc, ...(m.commandOverrides || {}) }),
        snapshot.commandOverrides
    );

    // 3. Build commands
    const emit = createEmitProxy(aggregateName, allEventOverrides, namingStrategy);
    const allCommandsMap = {
        ...commandsFactory(emit, {
            selectors: allSelectors,
            commands: createCommandContextProxy<Record<string, unknown>>()
        }),
        ...mixins.reduce((acc, m) => ({
            ...acc,
            ...(m.commandFactory ? m.commandFactory(emit, {
                selectors: allSelectors,
                commands: createCommandContextProxy<Record<string, unknown>>()
            }) : {})
        }), {} as Record<string, unknown>)
    } as Record<string, unknown>;

    // 4. Mount entities (mutates allEvents, allEventOverrides, allCommandsMap, etc.)
    const mounts = mountEntities<S, TMeta>(
        entityPackages, allEvents, allEventMetadata, allEventOverrides, allCommandOverrides,
        allSelectors, allCommandsMap as GenericCommandMap, projectorByEventType, scopedProjectorByEventType,
        scopedEventProjectors, aggregateName, namingStrategy
    );

    // 5. Finalize projector map with remaining root events
    finalizeProjectorMap(allEvents, allEventOverrides, projectorByEventType, aggregateName, namingStrategy);

    // 6. Build metadata
    const metadataByEventType = buildEventMetadata(allEvents, allEventMetadata, allEventOverrides, aggregateName, namingStrategy);
    const metadataByCommandType = buildCommandMetadata(allCommandsMap as GenericCommandMap, allCommandOverrides, aggregateName, namingStrategy);

    // 7. Build command handlers and type maps
    const commandHandlerByType = buildCommandHandlers<S>(allCommandsMap as GenericCommandMap, allCommandOverrides, aggregateName, namingStrategy);
    const commandTypesByKey = buildTypeMap(allCommandsMap as Record<string, unknown>, allCommandOverrides, aggregateName, namingStrategy, 'command');
    const eventTypesByKey = buildTypeMap(allEvents, allEventOverrides, aggregateName, namingStrategy, 'event');

    // Convert Map to plain object for applyEvent compatibility
    const projectorByEventTypeObj: Record<string, AnyFunction> = {};
    projectorByEventType.forEach((fn, key) => { projectorByEventTypeObj[key] = fn; });

    return {
        aggregateType: aggregateName,
        initialState,
        process: createCommandProcessor<S>(aggregateName, allCommandsMap as GenericCommandMap, allCommandOverrides, commandHandlerByType),
        apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides, projectorByEventTypeObj, scopedProjectorByEventType, scopedEventProjectors),
        applyToDraft: (draft: S, event: Event): void => {
            applyEventToDraft(aggregateName, draft as Draft<S>, event, allEvents, allEventOverrides, projectorByEventTypeObj, scopedProjectorByEventType, scopedEventProjectors);
        },
        commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap as GenericCommandMap, allCommandOverrides, namingStrategy),
        eventCreators: emit,
        pure: {
            commandProcessors: allCommandsMap as unknown as Record<string, AnyFunction>,
            eventProjectors: allEvents
        },
        selectors: allSelectors,
        hooks,
        mounts,
        metadata: { commands: metadataByCommandType, events: metadataByEventType },
        types: { commands: commandTypesByKey, events: eventTypesByKey },
        plugins
    };
}

function buildEventMetadata<TMeta>(
    allEvents: Record<string, AnyFunction>,
    allEventMetadata: Record<string, TMeta | undefined>,
    allEventOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, { meta?: TMeta }> {
    const keys = Array.from(new Set([...Object.keys(allEvents), ...Object.keys(allEventMetadata)]));
    return keys.reduce((acc, eventKey) => {
        const resolvedEventType = allEventOverrides[eventKey] || namingStrategy.event(aggregateName, eventKey);
        const meta = allEventMetadata[eventKey];
        acc[resolvedEventType] = meta !== undefined ? { meta } : {};
        return acc;
    }, {} as Record<string, { meta?: TMeta }>);
}

function buildCommandMetadata<TMeta>(
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, { meta?: TMeta }> {
    return Object.keys(allCommandsMap).reduce((acc, key) => {
        const resolvedCommandType = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        const def = allCommandsMap[key];
        const meta = (def && typeof def === 'object' && 'meta' in def ? (def as Record<string, unknown>).meta : undefined) as TMeta | undefined;
        acc[resolvedCommandType] = meta !== undefined ? { meta } : {};
        return acc;
    }, {} as Record<string, { meta?: TMeta }>);
}

function buildCommandHandlers<S>(
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[]> {
    return Object.keys(allCommandsMap).reduce((acc, key) => {
        const resolvedCommandType = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        // SAFETY: cast needed — resolveCommandHandler returns a narrower type than the union this map holds
        acc[resolvedCommandType] = resolveCommandHandler<S>(allCommandsMap[key]!) as any;
        return acc;
    }, {} as Record<string, (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[]>);
}

function buildTypeMap(
    map: Record<string, unknown>,
    overrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy,
    kind: 'command' | 'event'
): Record<string, string> {
    return Object.keys(map).reduce((acc, key) => {
        acc[key] = overrides[key] || namingStrategy[kind](aggregateName, key);
        return acc;
    }, {} as Record<string, string>);
}
