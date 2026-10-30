import type { Event, NamingStrategy, AggregateHooks, RedemeinePlugin, Contract } from '@redemeine/kernel';
import type { MountedEntityPackage } from './types/entityMount';
import type { AggregateMixinLike, AggregateSelectorsMap } from './types/aggregate';
import type { GenericCommandFactory } from './redemeineComponent';
import type { UnmatchedEventHandler } from './createAggregate';
import { createCommandProcessor } from './createCommandProcessor';
import { createEmitProxy } from './proxies/createEmitProxy';
import { createCommandCreatorsProxy } from './proxies/createCommandCreatorsProxy';
import { createCommandContextProxy } from './proxies/createCommandContextProxy';
import { applyEvent, applyEventToDraft, type CompiledEventRegistration } from './applyEvent';
import type { Draft } from 'immer';
import { resolveEvents } from './build/resolveEvents';
import { mountEntities } from './build/mountEntities';
import { mergeDefinitions } from './build/entityCommandTarget';
import { compileCommands } from './build/compileCommands';
import { ownDefinition } from './build/definitionMap';
import { validateListMounts } from './build/primaryKey';
import { attachCommandMetadata } from './commandMetadata';
import type { AggregateStateView } from './types/aggregateState';
import { decorateAggregate, inheritAggregateIdentity } from './plugins/attachment';
import type { PluginRegistration } from './plugins/attachmentTypes';

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
    aggregatePlugins?: PluginRegistration[];
    parents?: object[];
    unmatchedEventHandler?: UnmatchedEventHandler;
    contract?: Contract;
};

/**
 * Orchestrates the full aggregate build: resolves events, commands, mounts entities,
 * and assembles the final aggregate object.
 */
export function buildAggregate<S, TMeta extends Record<string, unknown>>(input: BuildAggregateInput<S, TMeta>) {
    const { aggregateName, initialState, snapshot, commandsFactory, mixins, entityPackages, namingStrategy, hooks, plugins, unmatchedEventHandler, contract } = input;
    validateListMounts([...entityPackages, ...mixins.flatMap(mixin =>
        Object.entries(mixin.mounts ?? {}).map(([name, mount]) => ({ ...mount, name })))]);
    for (const mixin of mixins) validateListMounts(Object.values(mixin.mounts ?? {}));

    // 1. Resolve events from mixins
    const resolved = resolveEvents<S, TMeta>(snapshot, mixins, aggregateName, namingStrategy);
    const { allEvents, allEventMetadata, allEventOverrides, dispatch } = resolved;

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
    const context = () => ({ selectors: allSelectors, commands: createCommandContextProxy<Record<string, unknown>>() });
    const allCommandsMap = mergeDefinitions(Object.create(null), commandsFactory(emit, context()));
    for (const mixin of mixins) {
        const commands = mixin.commandFactory?.(emit, context()) ?? {};
        mergeDefinitions(allCommandsMap, commands);
    }

    // 4. Mount entities (mutates allEvents, allEventOverrides, allCommandsMap, etc.)
    const mounts = mountEntities<S, TMeta>(
        entityPackages, allEvents, allEventMetadata, allEventOverrides, allCommandOverrides,
        allSelectors, allCommandsMap, dispatch, aggregateName, namingStrategy
    );

    // 6. Build metadata
    const metadataByEventType = buildEventMetadata(dispatch);

    // 7. Build command handlers, metadata, and type maps in a single pass
    const compiled = compileCommands(allCommandsMap, allCommandOverrides, aggregateName, namingStrategy);
    const eventTypesByKey = buildTypeMap(allEvents, allEventOverrides, aggregateName, namingStrategy, 'event', Object.keys(allEventMetadata));

    const domain = {
        aggregateType: aggregateName,
        initialState: initialState as AggregateStateView<S>,
        process: createCommandProcessor<S>(aggregateName, compiled.snapshot, allCommandOverrides, compiled.handlers, contract, compiled.targetsByType, compiled.staticByType),
        apply: (state: AggregateStateView<S>, event: Event): AggregateStateView<S> => applyEvent(aggregateName, state, event, dispatch, unmatchedEventHandler),
        applyToDraft: (draft: Draft<S>, event: Event): void => {
            applyEventToDraft<S>(aggregateName, draft, event, dispatch, unmatchedEventHandler);
        },
        commandCreators: createCommandCreatorsProxy(aggregateName, compiled.snapshot, compiled.types, namingStrategy),
        eventCreators: emit,
        pure: {
            commandProcessors: compiled.snapshot,
            eventProjectors: allEvents
        },
        selectors: allSelectors,
        hooks,
        mounts,
        metadata: { commands: compiled.metadata, events: metadataByEventType },
        types: { commands: compiled.types, events: eventTypesByKey },
        plugins
    };
    attachCommandMetadata(domain, compiled.records);
    const host = decorateAggregate(domain);
    inheritAggregateIdentity(host, input.parents ?? []);
    return decorateAggregate(host, input.aggregatePlugins);
}

function buildEventMetadata<TMeta>(
    dispatch: ReadonlyMap<string, CompiledEventRegistration<TMeta>>
): Record<string, { meta?: TMeta }> {
    const metadata: Record<string, { meta?: TMeta }> = Object.create(null);
    for (const [type, registration] of dispatch) {
        metadata[type] = registration.metadata !== undefined ? { meta: registration.metadata } : {};
    }
    return metadata;
}

function buildTypeMap(
    map: Record<string, any>,
    overrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy,
    kind: 'command' | 'event',
    registrationKeys: string[] = []
): Record<string, string> {
    return [...new Set([...Object.keys(map), ...registrationKeys])].reduce<Record<string, string>>((acc, key) => {
        acc[key] = ownDefinition(overrides, key) || namingStrategy[kind](aggregateName, key);
        return acc;
    }, Object.create(null));
}
