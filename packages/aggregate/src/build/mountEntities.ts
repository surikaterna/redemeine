import type { NamingStrategy } from '@redemeine/kernel';
import type { EntityCommandTargets, MountedEntityPackage, MountedStructureMetadata } from '../types/entityMount';
import type { AggregateSelectorsMap } from '../types/aggregate';
import type { GenericCommandMap } from '../redemeineComponent';
import { createEmitProxy } from '../proxies/createEmitProxy';
import { createCommandContextProxy } from '../proxies/createCommandContextProxy';
import { createRoleCommandResolver, entitySelectorContext } from './entityCommandContext';
import { commandTarget, definitionTargets } from './entityCommandTarget';

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
    projectorByEventType: Map<string, Function>,
    scopedProjectorByEventType: Record<string, Function>,
    scopedEventProjectors: Record<string, Function>,
    aggregateName: string,
    namingStrategy: NamingStrategy,
    eventTargetsByType: EntityCommandTargets = {}
): Record<string, MountedStructureMetadata> {
    const mounts: Record<string, MountedStructureMetadata> = {};

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
            ...((mountOverrides && mountOverrides.eventOverrides) || {}),
            ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
        };

        Object.keys(entityEvents).forEach((eventKey) => {
            allEvents[eventKey] = entityEvents[eventKey];
            const chain = [target, ...(nestedEventTargets[eventKey] ?? [])];
            definitionTargets(allEvents)[eventKey] = chain;
            scopedEventProjectors[`${entityPath}:${eventKey}`] = entityEvents[eventKey];
            allEventMetadata[`${entityPath}:${eventKey}`] = entityEventMetadata[eventKey];
            const mountEventOverride = (mountEventNameOverrides as Record<string, string>)[eventKey];
            const entityEventOverride = (entityEventNameOverrides as Record<string, string>)[eventKey];
            const scopedEventType = mountEventOverride
                || (entityEventOverride
                    ? composeMountedType(entityPath, entityEventOverride, 'event')
                    : namingStrategy.event(aggregateName, eventKey, entityPath));
            allEventOverrides[`${entityPath}:${eventKey}`] = scopedEventType;
            projectorByEventType.set(scopedEventType, entityEvents[eventKey]);
            scopedProjectorByEventType[scopedEventType] = entityEvents[eventKey];
            mounts[mountName]!.eventTargets![scopedEventType] = chain;
            eventTargetsByType[scopedEventType] = mounts[mountName]!.eventTargets![scopedEventType]!;
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
            ...((mountOverrides && mountOverrides.commandOverrides) || {}),
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
