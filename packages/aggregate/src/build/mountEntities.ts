import type { NamingStrategy } from '@redemeine/kernel';
import type { MountedEntityPackage, MountedStructureMetadata } from '../types/entityMount';
import type { CompiledEventRegistration } from '../applyEvent';
import type { AggregateSelectorsMap } from '../types/aggregate';
import type { GenericCommandMap } from '../redemeineComponent';
import { createEmitProxy } from '../proxies/createEmitProxy';
import { createCommandContextProxy } from '../proxies/createCommandContextProxy';
import { createRoleCommandResolver, entitySelectorContext } from './entityCommandContext';
import { commandTarget, definitionTargets, snapshotTargetChain } from './entityCommandTarget';
import { eventDefinitionKeys } from './eventDefinitions';

export type MountResult<TMeta> = {
    mounts: Record<string, MountedStructureMetadata>;
};

/**
 * Mounts entity packages into the aggregate, populating projector maps, command maps,
 * event overrides, and metadata. Mutates the passed collections for performance.
 */
export function mountEntities<S, TMeta>(
    entityPackages: MountedEntityPackage[],
    allEvents: Record<string, Function>,
    allEventMetadata: Record<string, TMeta | undefined>,
    allEventOverrides: Record<string, string>,
    allCommandOverrides: Record<string, string>,
    allSelectors: AggregateSelectorsMap<S>,
    allCommandsMap: GenericCommandMap,
    dispatch: Map<string, CompiledEventRegistration>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, MountedStructureMetadata> {
    const mounts: Record<string, MountedStructureMetadata> = {};
    const eventDefinitionTargets = definitionTargets(allEvents);
    // Preserve resolved root ownership, but retain last-mounted fallback for entity-only keys.
    const rootEventKeys = new Set(Object.keys(allEvents).filter(key => !eventDefinitionTargets[key]?.length));

    const composeMountedType = (path: string, relativeName: string, suffix: 'event' | 'command') => {
        const expectedSuffix = `.${suffix}`;
        const normalized = relativeName.endsWith(expectedSuffix)
            ? relativeName
            : `${relativeName}${expectedSuffix}`;
        return `${aggregateName}.${path}.${normalized}`;
    };

    entityPackages.forEach(({ name: mountName, kind, component: entity, mountOverrides, pk, knownKeys }) => {
        const previous = mounts[mountName];
        mounts[mountName] = { kind, commandPrefix: mountName, statePath: [mountName], pk, knownKeys, entity,
            commandTargets: { ...previous?.commandTargets }, eventTargets: { ...previous?.eventTargets } };
        const target = commandTarget(mounts[mountName]!);

        if (!entity || kind === 'valueObject') return;

        const collectionName = mountName + 's';
        const entityPath = collectionName.replace(/s$/, '').replace(/([A-Z])/g, '_$1').toLowerCase();
        const entityEvents = entity.projectors || entity.events || {};
        const nestedEventTargets = definitionTargets(entityEvents);
        const entityEventMetadata = (entity as unknown as { eventMetadata?: Record<string, TMeta | undefined> }).eventMetadata || {};
        const entityEventNameOverrides = entity.eventOverrides || {};
        const mountEventNameOverrides = {
            ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
        };

        eventDefinitionKeys(entityEvents).forEach((eventKey) => {
            const chain = [target, ...(nestedEventTargets[eventKey] ?? [])];
            if (!rootEventKeys.has(eventKey)) {
                allEvents[eventKey] = entityEvents[eventKey];
                eventDefinitionTargets[eventKey] = chain;
            }
            allEventMetadata[`${entityPath}:${eventKey}`] = entityEventMetadata[eventKey];
            const mountEventOverride = (mountEventNameOverrides as Record<string, string>)[eventKey];
            const entityEventOverride = (entityEventNameOverrides as Record<string, string>)[eventKey];
            const scopedEventType = mountEventOverride
                || (entityEventOverride
                    ? composeMountedType(entityPath, entityEventOverride, 'event')
                    : namingStrategy.event(aggregateName, eventKey, entityPath));
            allEventOverrides[`${entityPath}:${eventKey}`] = scopedEventType;
            dispatch.set(scopedEventType, { projector: entityEvents[eventKey]!, targets: snapshotTargetChain(chain) });
            mounts[mountName]!.eventTargets![scopedEventType] = chain;
        });

        const mergedSelectors = entitySelectorContext(entity.selectors || {}, allSelectors, mountName);

        const entityEmit = createEmitProxy(aggregateName, allEventOverrides, namingStrategy, entityPath);
        const entityCommands = entity.commandFactory(entityEmit, {
            selectors: mergedSelectors,
            commands: createCommandContextProxy<Record<string, unknown>>()
        });
        const nestedTargets = definitionTargets(entityCommands);
        mounts[mountName]!.commandNames = Object.keys(entityCommands);
        mounts[mountName]!.getRoleCommandNames = createRoleCommandResolver(entityEmit, allSelectors, mountName);
        const entityCommandNameOverrides = entity.commandOverrides || {};
        const mountCommandNameOverrides = {
            ...((mountOverrides && mountOverrides.commandNameOverrides) || {})
        };

        Object.keys(entityCommands).forEach(cmdProp => {
            const mappedCmd = mountName + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
            allCommandsMap[mappedCmd] = entityCommands[cmdProp]!;
            mounts[mountName]!.commandTargets![mappedCmd] = [target, ...(nestedTargets[cmdProp] ?? [])];
            definitionTargets(allCommandsMap)[mappedCmd] = mounts[mountName]!.commandTargets![mappedCmd]!;
            const mountCommandOverride = (mountCommandNameOverrides as Record<string, string>)[cmdProp];
            const entityCommandOverride = (entityCommandNameOverrides as Record<string, string>)[cmdProp];
            if (mountCommandOverride) {
                allCommandOverrides[mappedCmd] = mountCommandOverride;
            } else if (entityCommandOverride) {
                allCommandOverrides[mappedCmd] = composeMountedType(entityPath, entityCommandOverride, 'command');
            }
        });
    });

    return mounts;
}
