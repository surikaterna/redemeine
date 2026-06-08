import type { Event, NamingStrategy, AggregateHooks, RedemeinePlugin, Contract } from '@redemeine/kernel';
import type { MountedEntityPackage, MountedStructureMetadata } from './types/entityMount';
import type { AggregateMixinLike, AggregateSelectorsMap } from './types/aggregate';
import type { GenericCommandFactory } from './redemeineComponent';
import type { UnmatchedEventHandler } from './createAggregate';
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
        events: Record<string, Function>;
        eventMetadata: Record<string, Record<string, unknown> | undefined>;
        eventOverrides: Record<string, string>;
        commandOverrides: Record<string, string>;
        selectors: Record<string, Function>;
    };
    commandsFactory: GenericCommandFactory;
    mixins: AggregateMixinLike<S>[];
    entityPackages: MountedEntityPackage[];
    namingStrategy: NamingStrategy;
    hooks: AggregateHooks<S>;
    plugins: RedemeinePlugin<any>[];
    unmatchedEventHandler?: UnmatchedEventHandler;
    contract?: Contract;
};

/**
 * Orchestrates the full aggregate build: resolves events, commands, mounts entities,
 * and assembles the final aggregate object.
 */
export function buildAggregate<S, TMeta extends Record<string, unknown>>(input: BuildAggregateInput<S, TMeta>) {
    const { aggregateName, initialState, snapshot, commandsFactory, mixins, entityPackages, namingStrategy, hooks, plugins, unmatchedEventHandler, contract } = input;

    // 1. Resolve events from mixins
    const resolved = resolveEvents<S, TMeta>(snapshot, mixins, aggregateName, namingStrategy);
    const { allEvents, allEventMetadata, allEventOverrides, projectorByEventType, scopedProjectorByEventType, scopedEventProjectors } = resolved;

    // 2. Merge selectors and command overrides from mixins
    const allSelectors = { ...snapshot.selectors } as AggregateSelectorsMap<S>;
    const allCommandOverrides = { ...snapshot.commandOverrides };
    for (const m of mixins) {
        if (m.selectors) Object.assign(allSelectors, m.selectors);
        if (m.commandOverrides) Object.assign(allCommandOverrides, m.commandOverrides);
    }

    // 3. Build commands
    const emit = createEmitProxy(aggregateName, allEventOverrides, namingStrategy);
    const allCommandsMap = {
        ...commandsFactory(emit, {
            selectors: allSelectors,
            commands: createCommandContextProxy<Record<string, unknown>>()
        }),
        ...mergeMixinCommands(mixins, emit, allSelectors)
    } as Record<string, unknown>;

    // 4. Mount entities (mutates allEvents, allEventOverrides, allCommandsMap, etc.)
    const mounts = mountEntities<S, TMeta>(
        entityPackages, allEvents, allEventMetadata, allEventOverrides, allCommandOverrides,
        allSelectors, allCommandsMap as any, projectorByEventType, scopedProjectorByEventType,
        scopedEventProjectors, aggregateName, namingStrategy
    );

    // 5. Finalize projector map with remaining root events
    finalizeProjectorMap(allEvents, allEventOverrides, projectorByEventType, aggregateName, namingStrategy);

    // 6. Build metadata
    const metadataByEventType = buildEventMetadata(allEvents, allEventMetadata, allEventOverrides, aggregateName, namingStrategy);

    // 7. Build command handlers, metadata, and type maps in a single pass
    const { commandHandlerByType, commandTypesByKey, metadataByCommandType } =
        resolveCommandMaps<S, TMeta>(allCommandsMap as any, allCommandOverrides, aggregateName, namingStrategy);
    const eventTypesByKey = buildTypeMap(allEvents, allEventOverrides, aggregateName, namingStrategy, 'event');

    // Convert Map to plain object for applyEvent compatibility
    const projectorByEventTypeObj: Record<string, Function> = {};
    projectorByEventType.forEach((fn, key) => { projectorByEventTypeObj[key] = fn; });

    return {
        aggregateType: aggregateName,
        initialState,
        process: createCommandProcessor<S>(aggregateName, allCommandsMap as any, allCommandOverrides, commandHandlerByType, contract),
        apply: (state: S, event: Event): S => applyEvent(aggregateName, state, event, allEvents, allEventOverrides, projectorByEventTypeObj, scopedProjectorByEventType, scopedEventProjectors, unmatchedEventHandler),
        applyToDraft: (draft: S, event: Event): void => {
            applyEventToDraft(aggregateName, draft as Draft<S>, event, allEvents, allEventOverrides, projectorByEventTypeObj, scopedProjectorByEventType, scopedEventProjectors, unmatchedEventHandler);
        },
        commandCreators: createCommandCreatorsProxy(aggregateName, allCommandsMap as any, allCommandOverrides, namingStrategy),
        eventCreators: emit,
        pure: {
            commandProcessors: allCommandsMap as unknown as Record<string, Function>,
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

function mergeMixinCommands<S>(
    mixins: AggregateMixinLike<S>[],
    // SAFETY: `unknown` — emit proxy is dynamically typed via Proxy handler, commandFactory accepts unknown
    emit: unknown,
    allSelectors: AggregateSelectorsMap<S>
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const m of mixins) {
        if (m.commandFactory) {
            Object.assign(result, m.commandFactory(emit, {
                selectors: allSelectors,
                commands: createCommandContextProxy<Record<string, unknown>>()
            }));
        }
    }
    return result;
}

function buildEventMetadata<TMeta>(
    allEvents: Record<string, Function>,
    allEventMetadata: Record<string, TMeta | undefined>,
    allEventOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, { meta?: TMeta }> {
    const keys = Array.from(new Set([...Object.keys(allEvents), ...Object.keys(allEventMetadata)]));
    const result: Record<string, { meta?: TMeta }> = {};
    for (const eventKey of keys) {
        const resolvedEventType = allEventOverrides[eventKey] || namingStrategy.event(aggregateName, eventKey);
        const meta = allEventMetadata[eventKey];
        result[resolvedEventType] = meta !== undefined ? { meta } : {};
    }
    return result;
}

/**
 * Single-pass resolution of command handlers, metadata, and type map.
 * Avoids iterating allCommandsMap three times with the same key resolution logic.
 */
function resolveCommandMaps<S, TMeta>(
    // SAFETY: `any` required — allCommandsMap entries have heterogeneous shapes (shorthand fns, packed objects, meta-wrapped)
    allCommandsMap: Record<string, any>,
    allCommandOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): {
    // SAFETY: `any` required — command handlers have varying signatures resolved at runtime
    commandHandlerByType: Record<string, any>;
    commandTypesByKey: Record<string, string>;
    metadataByCommandType: Record<string, { meta?: TMeta }>;
} {
    // SAFETY: `any` — mirrors commandHandlerByType constraint above
    const commandHandlerByType: Record<string, any> = {};
    const commandTypesByKey: Record<string, string> = {};
    const metadataByCommandType: Record<string, { meta?: TMeta }> = {};

    for (const key of Object.keys(allCommandsMap)) {
        const resolvedCommandType = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        commandHandlerByType[resolvedCommandType] = resolveCommandHandler<S>(allCommandsMap[key]!);
        commandTypesByKey[key] = resolvedCommandType;
        // SAFETY: `as any` — command entries may or may not have meta; shape is not statically known
        const meta = (allCommandsMap[key] as any)?.meta as TMeta | undefined;
        metadataByCommandType[resolvedCommandType] = meta !== undefined ? { meta } : {};
    }

    return { commandHandlerByType, commandTypesByKey, metadataByCommandType };
}

function buildTypeMap(
    // SAFETY: `any` required — map entries may be functions or objects with varying shapes
    map: Record<string, any>,
    overrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy,
    kind: 'command' | 'event'
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(map)) {
        result[key] = overrides[key] || namingStrategy[kind](aggregateName, key);
    }
    return result;
}
