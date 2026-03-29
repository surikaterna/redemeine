import type { EntityPackage } from './createEntity';
import type { GenericCommandFactory, GenericCommandFactoryContext, GenericCommandMap } from './redemeineComponent';

export type MapEntityCommands<Name extends string, CPayloads> = {
  [K in keyof CPayloads as K extends string ? `${Name}${Capitalize<K>}` : never]: CPayloads[K]
};

export type EntityListOptions<PK extends string | readonly string[] = string | readonly string[]> = {
  pk?: PK;
};

export type EntityMapOptions<K extends string = string> = {
  knownKeys?: readonly K[];
};

export type EntityMountOverrides = {
  eventNameOverrides?: Record<string, string>;
  commandNameOverrides?: Record<string, string>;
  /** @deprecated Use eventNameOverrides */
  eventOverrides?: Record<string, string>;
  /** @deprecated Use commandNameOverrides */
  commandOverrides?: Record<string, string>;
};

export type MountedStructureKind = 'list' | 'map' | 'valueObjectList' | 'valueObjectMap';

export type MountedStructureMetadata = {
  kind: MountedStructureKind;
  commandPrefix: string;
  statePath: string[];
  pk?: string | readonly string[];
  knownKeys?: readonly string[];
};

export type MountedEntityPackage = {
  name: string;
  kind: MountedStructureKind;
  component?: EntityPackage<unknown, string>;
  mountOverrides?: EntityMountOverrides;
  pk?: string | readonly string[];
  knownKeys?: readonly string[];
};

type ComponentBehaviorSnapshot = {
  events: Record<string, Function>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  commandOverrides: Record<string, string>;
};

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

  const mergedEvents: Record<string, Function> = { ...snapshot.events };
  const mergedEventMetadata: Record<string, Record<string, unknown> | undefined> = { ...snapshot.eventMetadata };
  const mergedEventOverrides: Record<string, string> = { ...snapshot.eventOverrides };
  const mergedCommandOverrides: Record<string, string> = { ...snapshot.commandOverrides };
  const mounts: Record<string, MountedStructureMetadata> = {};

  mountedEntities.forEach(({ name: mountName, kind, component: nested, mountOverrides, pk, knownKeys }) => {
    mounts[mountName] = {
      kind,
      commandPrefix: mountName,
      statePath: [mountName],
      pk,
      knownKeys
    };

    if (!nested || (kind !== 'list' && kind !== 'map')) {
      return;
    }

    const nestedEvents = nested.projectors || nested.events || {};
    const nestedEventMetadata = nested.eventMetadata || {};
    const nestedEventNameOverrides = nested.eventOverrides || {};
    const nestedCommandNameOverrides = nested.commandOverrides || {};
    const mountEventNameOverrides = {
      ...((mountOverrides && mountOverrides.eventOverrides) || {}),
      ...((mountOverrides && mountOverrides.eventNameOverrides) || {})
    } as Record<string, string>;
    const mountCommandNameOverrides = {
      ...((mountOverrides && mountOverrides.commandOverrides) || {}),
      ...((mountOverrides && mountOverrides.commandNameOverrides) || {})
    } as Record<string, string>;

    Object.keys(nestedEvents).forEach((eventKey) => {
      const mappedEventKey = `${mountName}${capitalize(eventKey)}`;
      mergedEvents[mappedEventKey] = nestedEvents[eventKey];
      mergedEventMetadata[mappedEventKey] = (nestedEventMetadata as Record<string, Record<string, unknown> | undefined>)[eventKey];
      if (mountEventNameOverrides[eventKey]) {
        mergedEventOverrides[mappedEventKey] = mountEventNameOverrides[eventKey];
      } else if ((nestedEventNameOverrides as Record<string, string>)[eventKey]) {
        mergedEventOverrides[mappedEventKey] = (nestedEventNameOverrides as Record<string, string>)[eventKey];
      }
    });

    Object.keys(nestedCommandNameOverrides as Record<string, string>).forEach((cmdKey) => {
      const mappedCmdKey = `${mountName}${capitalize(cmdKey)}`;
      mergedCommandOverrides[mappedCmdKey] = (nestedCommandNameOverrides as Record<string, string>)[cmdKey];
    });

    Object.keys(mountCommandNameOverrides).forEach((cmdKey) => {
      const mappedCmdKey = `${mountName}${capitalize(cmdKey)}`;
      mergedCommandOverrides[mappedCmdKey] = mountCommandNameOverrides[cmdKey];
    });
  });

  const commandFactory: GenericCommandFactory = (emit: unknown, context: GenericCommandFactoryContext) => {
    const mergedCommands: GenericCommandMap = {
      ...baseCommandFactory(emit, context)
    };

    mountedEntities.forEach(({ name: mountName, kind, component: nested }) => {
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

      const nestedCommands = nested.commandFactory(nestedEmit, context);
      Object.keys(nestedCommands).forEach((cmdKey) => {
        mergedCommands[`${mountName}${capitalize(cmdKey)}`] = nestedCommands[cmdKey];
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
