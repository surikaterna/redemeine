import type { NamingStrategy, ReadonlyDeep, Event } from '@redemeine/kernel';
import type { AggregateMixinLike, AggregateSelectorsMap } from '../types/aggregate';
import type { GenericCommandFactory, GenericCommandMap } from '../redemeineComponent';
import { resolveCommandHandler } from '../redemeineComponent';
import { createEmitProxy } from '../proxies/createEmitProxy';
import { createCommandContextProxy } from '../proxies/createCommandContextProxy';

export type ResolvedCommands<S, TMeta> = {
    allCommandsMap: GenericCommandMap;
    allCommandOverrides: Record<string, string>;
    commandHandlerByType: Record<string, (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[]>;
    commandTypesByKey: Record<string, string>;
    metadataByCommandType: Record<string, { meta?: TMeta }>;
};

/**
 * Merges mixin commands and builds command handler/type maps.
 */
export function resolveCommands<S, TMeta>(
    commandsFactory: GenericCommandFactory,
    mixins: AggregateMixinLike<S>[],
    allSelectors: AggregateSelectorsMap<S>,
    allEventOverrides: Record<string, string>,
    allCommandOverrides: Record<string, string>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): ResolvedCommands<S, TMeta> {
    const emit = createEmitProxy(aggregateName, allEventOverrides, namingStrategy);

    const allCommandsMap: GenericCommandMap = {
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
        }), {} as GenericCommandMap)
    };

    const commandHandlerByType = Object.keys(allCommandsMap).reduce((acc, key) => {
        const resolvedCommandType = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        acc[resolvedCommandType] = resolveCommandHandler<S>(allCommandsMap[key]!) as any;
        return acc;
    }, {} as Record<string, (state: ReadonlyDeep<S>, payload: unknown) => Event | { events: Event[]; intents?: Record<string, unknown> } | Event[]>);

    const commandTypesByKey = Object.keys(allCommandsMap).reduce((acc, key) => {
        acc[key] = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        return acc;
    }, {} as Record<string, string>);

    const metadataByCommandType = Object.keys(allCommandsMap).reduce((acc, key) => {
        const resolvedCommandType = allCommandOverrides[key] || namingStrategy.command(aggregateName, key);
        const commandDefinition = allCommandsMap[key] as unknown as { meta?: TMeta };
        const meta = commandDefinition?.meta;
        acc[resolvedCommandType] = meta !== undefined ? { meta } : {};
        return acc;
    }, {} as Record<string, { meta?: TMeta }>);

    return { allCommandsMap, allCommandOverrides, commandHandlerByType, commandTypesByKey, metadataByCommandType };
}
