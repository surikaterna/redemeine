import type { EntityPackage } from './createEntity';
import { resolveCommandFactoryContext, type GenericCommandFactory, type GenericCommandFactoryContext, type GenericCommandMap } from './redemeineComponent';
import type { MountedStructureKind, MountedStructureMetadata, MountedEntityPackage, EntityMountOverrides, EntityListOptions, EntityMapOptions } from './types/entityMount';
import type { MapEntityCommands } from './types/aggregate';
import { entitySelectorContext } from './build/entityCommandContext';
import { commandTarget, definitionTargets, mergeDefinitions } from './build/entityCommandTarget';
import { eventDefinitionKeys, mergeEventDefinitions, recordEventAssignment } from './build/eventDefinitions';
import { primaryKey, validateListMounts } from './build/primaryKey';
import { ownDefinition } from './build/definitionMap';

export type { MountedStructureKind, MountedStructureMetadata, MountedEntityPackage, EntityMountOverrides, EntityListOptions, EntityMapOptions, MapEntityCommands };

type ComponentBehaviorSnapshot = {
  events: Record<string, Function>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  commandOverrides: Record<string, string>;
};

/**
 * Creates the fluent mount methods (entityList, entityMap, valueObjectList, valueObjectMap)
 * shared between createEntity and createMixin builders.
 */
export function createMountMethods<B extends object>(builder: B, mountedEntities: MountedEntityPackage[]): B {
  Object.assign(builder, {
    entityList: <const PK extends string | readonly string[]>(entityName: string, entityComponent: EntityPackage<unknown, string>, options?: EntityListOptions<PK>, mountOverrides?: EntityMountOverrides) => {
      mountedEntities.push({ name: entityName, kind: 'list', component: entityComponent, mountOverrides, pk: primaryKey(options?.pk) });
      return builder;
    },
    entityMap: (entityName: string, entityComponent: EntityPackage<unknown, string>, options?: EntityMapOptions, mountOverrides?: EntityMountOverrides) => {
      mountedEntities.push({ name: entityName, kind: 'map', component: entityComponent, mountOverrides, knownKeys: options?.knownKeys });
      return builder;
    },
    valueObjectList: (entityName: string) => {
      mountedEntities.push({ name: entityName, kind: 'valueObjectList' });
      return builder;
    },
    valueObjectMap: (entityName: string) => {
      mountedEntities.push({ name: entityName, kind: 'valueObjectMap' });
      return builder;
    },
  });
  return builder;
}

export function composeMountedComponentBehavior(
  mountedEntities: MountedEntityPackage[],
  snapshot: ComponentBehaviorSnapshot,
  baseCommandFactory: GenericCommandFactory
): {
  mergedEvents: Record<string, Function>;
  mergedEventMetadata: Record<string, Record<string, unknown> | undefined>;
  mergedEventOverrides: Record<string, string>;
  mergedCommandOverrides: Record<string, string>;
  mounts: Record<string, MountedStructureMetadata>;
  commandFactory: GenericCommandFactory;
} {
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  validateListMounts(mountedEntities);

  const mergedEvents = mergeEventDefinitions(Object.create(null), snapshot.events);
  const mergedEventMetadata: Record<string, Record<string, unknown> | undefined> = { ...snapshot.eventMetadata };
  const mergedEventOverrides: Record<string, string> = { ...snapshot.eventOverrides };
  const mergedCommandOverrides: Record<string, string> = { ...snapshot.commandOverrides };
  const mounts: Record<string, MountedStructureMetadata> = {};

  mountedEntities.forEach(({ name: mountName, kind, component: nested, mountOverrides, pk, knownKeys }) => {
    const previous = mounts[mountName];
    mounts[mountName] = {
      kind,
      commandPrefix: mountName,
      statePath: [mountName],
      pk,
      knownKeys,
      commandTargets: { ...previous?.commandTargets },
      eventTargets: { ...previous?.eventTargets }
    };

    if (!nested || (kind !== 'list' && kind !== 'map')) {
      return;
    }

    const nestedEvents = nested.projectors || nested.events || {};
    const nestedEventTargets = definitionTargets(nestedEvents);
    const target = commandTarget({ kind, commandPrefix: mountName, statePath: [mountName], pk });
    const nestedEventMetadata = nested.eventMetadata || {};
    const nestedEventNameOverrides = nested.eventOverrides || {};
    const nestedCommandNameOverrides = nested.commandOverrides || {};
    const mountEventNameOverrides = {
      ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
    } as Record<string, string>;
    const mountCommandNameOverrides = {
      ...((mountOverrides && mountOverrides.commandNameOverrides) || {})
    } as Record<string, string>;

    eventDefinitionKeys(nestedEvents).forEach((eventKey) => {
      const mappedEventKey = `${mountName}${capitalize(eventKey)}`;
      mergedEvents[mappedEventKey] = nestedEvents[eventKey];
      recordEventAssignment(mergedEvents, mappedEventKey);
      mounts[mountName]!.eventTargets![mappedEventKey] = [target, ...(nestedEventTargets[eventKey] ?? [])];
      definitionTargets(mergedEvents)[mappedEventKey] = mounts[mountName]!.eventTargets![mappedEventKey]!;
      mergedEventMetadata[mappedEventKey] = ownDefinition(nestedEventMetadata, eventKey);
      const override = ownDefinition(mountEventNameOverrides, eventKey) || ownDefinition(nestedEventNameOverrides, eventKey);
      if (override) mergedEventOverrides[mappedEventKey] = override;
    });

    Object.keys(nestedCommandNameOverrides as Record<string, string>).forEach((cmdKey) => {
      const mappedCmdKey = `${mountName}${capitalize(cmdKey)}`;
      mergedCommandOverrides[mappedCmdKey] = (nestedCommandNameOverrides as Record<string, string>)[cmdKey]!;
    });

    Object.keys(mountCommandNameOverrides).forEach((cmdKey) => {
      const mappedCmdKey = `${mountName}${capitalize(cmdKey)}`;
      mergedCommandOverrides[mappedCmdKey] = mountCommandNameOverrides[cmdKey]!;
    });
  });

  const commandFactory: GenericCommandFactory = (emit: unknown, context: GenericCommandFactoryContext) => {
    const resolvedContext = resolveCommandFactoryContext(context);
    const mergedCommands: GenericCommandMap = mergeDefinitions(Object.create(null), baseCommandFactory(emit, resolvedContext));

    mountedEntities.forEach(({ name: mountName, kind, component: nested, pk }) => {
      if (!nested || (kind !== 'list' && kind !== 'map')) {
        return;
      }

      const nestedEmit = new Proxy({}, {
        get(_target, prop) {
          if (typeof prop !== 'string') {
            return undefined;
          }
          return (emit as Record<string, unknown>)[`${mountName}${capitalize(prop)}`];
        }
      });

      const nestedCommands = nested.commandFactory(nestedEmit, {
        ...resolvedContext,
        selectors: entitySelectorContext(nested.selectors || {}, resolvedContext.selectors, mountName)
      });
      const nestedTargets = definitionTargets(nestedCommands);
      const target = commandTarget({ kind, commandPrefix: mountName, statePath: [mountName], pk });
      Object.keys(nestedCommands).forEach((cmdKey) => {
        const mapped = `${mountName}${capitalize(cmdKey)}`;
        mergedCommands[mapped] = nestedCommands[cmdKey]!;
        mounts[mountName]!.commandTargets![mapped] = [target, ...(nestedTargets[cmdKey] ?? [])];
        definitionTargets(mergedCommands)[mapped] = mounts[mountName]!.commandTargets![mapped]!;
      });
    });

    return mergedCommands;
  };

  return {
    mergedEvents,
    mergedEventMetadata,
    mergedEventOverrides,
    mergedCommandOverrides,
    mounts,
    commandFactory
  };
}
