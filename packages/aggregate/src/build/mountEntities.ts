import type { NamingStrategy } from '@redemeine/kernel';
import type { MountedEntityPackage, MountedStructureMetadata } from '../types/entityMount';
import type { CompiledEventRegistration } from '../applyEvent';
import type { AggregateSelectorsMap } from '../types/aggregate';
import type { GenericCommandMap } from '../redemeineComponent';
import { createEmitProxy } from '../proxies/createEmitProxy';
import { createCommandContextProxy } from '../proxies/createCommandContextProxy';
import { createRoleCommandResolver, entitySelectorContext } from './entityCommandContext';
import { commandTarget, definitionTargets, snapshotTargetChain, recordCommandName } from './entityCommandTarget';
import { eventDefinitionKeys } from './eventDefinitions';
import { ownDefinition } from './definitionMap';
import { commandModes } from '../entityCommandLifecycle';
import { mountName as recordMountedName, mountedWire, semanticSegment } from './mountedNaming';

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
    dispatch: Map<string, CompiledEventRegistration<TMeta>>,
    aggregateName: string,
    namingStrategy: NamingStrategy
): Record<string, MountedStructureMetadata> {
    const mounts: Record<string, MountedStructureMetadata> = {};
    const eventDefinitionTargets = definitionTargets(allEvents);
    // Preserve resolved root ownership, but retain last-mounted fallback for entity-only keys.
    const rootEventKeys = new Set(Object.keys(allEvents).filter(key => !eventDefinitionTargets[key]?.length));

    entityPackages.forEach(({ name: mountName, kind, component: entity, mountOverrides, pk, knownKeys }) => {
        const previous = mounts[mountName];
        mounts[mountName] = { kind, commandPrefix: mountName, statePath: [mountName], pk, knownKeys, entity,
            commandTargets: { ...previous?.commandTargets }, eventTargets: { ...previous?.eventTargets } };
        const target = commandTarget(mounts[mountName]!, entity?.initialState);

        if (!entity || kind === 'valueObject') return;

        const segment = semanticSegment(entity.name, mountOverrides);
        mounts[mountName]!.semanticName = segment;
        const eventNames: Record<string, Function> = Object.create(null);
        const eventWires: Record<string, string> = Object.create(null);
        const entityEvents = entity.projectors || entity.events || {};
        const nestedEventTargets = definitionTargets(entityEvents);
        const entityEventMetadata = (entity as unknown as { eventMetadata?: Record<string, TMeta | undefined> }).eventMetadata || {};
        const entityEventNameOverrides = entity.eventOverrides || {};
        const mountEventNameOverrides = {
            ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
        };

        eventDefinitionKeys(entityEvents).forEach((eventKey) => {
            const chain = [target, ...(nestedEventTargets[eventKey] ?? [])];
            recordMountedName(eventNames, eventKey, entityEvents, eventKey, segment,
                ownDefinition<string>(entityEventNameOverrides, eventKey), ownDefinition(mountEventNameOverrides, eventKey));
            const scopedEventType = mountedWire(eventNames, eventKey, aggregateName, namingStrategy, 'event')!;
            eventWires[eventKey] = scopedEventType;
            if (!rootEventKeys.has(eventKey)) {
                allEvents[eventKey] = entityEvents[eventKey];
                eventDefinitionTargets[eventKey] = chain;
                allEventOverrides[eventKey] = scopedEventType;
            }
            allEventMetadata[`${mountName}:${eventKey}`] = ownDefinition(entityEventMetadata, eventKey);
            allEventOverrides[`${mountName}:${eventKey}`] = scopedEventType;
            dispatch.set(scopedEventType, { projector: entityEvents[eventKey]!, targets: snapshotTargetChain(chain),
                metadata: ownDefinition(entityEventMetadata, eventKey) });
            mounts[mountName]!.eventTargets![scopedEventType] = chain;
        });

        const mergedSelectors = entitySelectorContext(entity.selectors || {}, allSelectors, mountName);

        const entityEmit = createEmitProxy(aggregateName, eventWires, namingStrategy);
        const entityCommands = entity.commandFactory(entityEmit, {
            selectors: mergedSelectors,
            commands: createCommandContextProxy<Record<string, unknown>>()
        });
        const nestedTargets = definitionTargets(entityCommands);
        mounts[mountName]!.commandNames = Object.keys(entityCommands);
        mounts[mountName]!.getRoleCommandNames = createRoleCommandResolver(entityEmit, allSelectors, mountName);

        Object.keys(entityCommands).forEach(cmdProp => {
            const mappedCmd = mountName + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
            recordCommandName(allCommandsMap, mappedCmd, entityCommands, cmdProp, mountName);
            recordMountedName(allCommandsMap, mappedCmd, entityCommands, cmdProp, segment,
                ownDefinition<string>(entity.commandOverrides || {}, cmdProp), ownDefinition(mountOverrides?.commandNameOverrides ?? {}, cmdProp));
            allCommandsMap[mappedCmd] = entityCommands[cmdProp]!;
            commandModes(allCommandsMap)[mappedCmd] = commandModes(entityCommands)[cmdProp] ?? false;
            mounts[mountName]!.commandTargets![mappedCmd] = [target, ...(nestedTargets[cmdProp] ?? [])];
            definitionTargets(allCommandsMap)[mappedCmd] = mounts[mountName]!.commandTargets![mappedCmd]!;
            const explicitOverride = ownDefinition(mountOverrides?.commandNameOverrides ?? {}, cmdProp)
                ?? ownDefinition<string>(entity.commandOverrides || {}, cmdProp);
            if (explicitOverride !== undefined) {
                allCommandOverrides[mappedCmd] = mountedWire(allCommandsMap, mappedCmd, aggregateName, namingStrategy, 'command')!;
            }
        });
    });

    return mounts;
}
