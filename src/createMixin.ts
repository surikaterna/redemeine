import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap, MapCommandsToPayloads } from './types';
import { RedemeineComponent, RedemeineCommandDefinition, GenericCommandFactory, GenericCommandMap, createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';
import type { EntityPackage } from './createEntity';
import {
  MapEntityCommands,
  EntityListOptions,
  EntityMapOptions,
  EntityMountOverrides,
  MountedStructureMetadata,
  MountedEntityPackage,
  composeMountedComponentBehavior
} from './componentMounts';

type MixinEntityRegistryListEntry<T extends EntityPackage<any, any, any, any, any, any>, PK extends string | readonly string[]> = {
  kind: 'list';
  entity: T;
  pk: PK;
};

type MixinEntityRegistryMapEntry<T extends EntityPackage<any, any, any, any, any, any>, Keys extends string = string> = {
  kind: 'map';
  entity: T;
  knownKeys?: readonly Keys[];
};

type MixinEntityRegistryValueObjectListEntry = {
  kind: 'valueObjectList';
};

type MixinEntityRegistryValueObjectMapEntry = {
  kind: 'valueObjectMap';
};

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled reusable piece of domain logic (Commands, Events, Selectors)
 * ready to be embedded horizontally into an AggregateBuilder via `.mixins()`.
 */
export interface MixinPackage<S, E = any, EOverrides extends object = {}, CPayloads = any, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, Registry extends Record<string, any> = {}>
  extends RedemeineComponent<S, CPayloads, E, E, Selectors, EOverrides, COverrides> {
  events: E;
  projectors: E;
  commands: CPayloads;
  eventOverrides: EOverrides;
  commandFactory: GenericCommandFactory;
  commandOverrides: COverrides;
  selectors: Selectors;
  mounts: Record<string, MountedStructureMetadata>;
  mountedEntities: MountedEntityPackage[];
  __registryType?: Registry;
}

export interface MixinBuilder<S, E = {}, EOverrides extends object = {}, CPayloads = {}, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, Registry extends Record<string, any> = {}> {
  /**
   * Register event handlers for this Mixin that apply state mutations.
   */
  events: <NewE extends Record<string, (state: S, event: Event<any, any>) => void>>(
    events: NewE
  ) => MixinBuilder<S, E & NewE, EOverrides, CPayloads, COverrides, Selectors, Registry>;

  overrideEventNames: <NewEOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: NewEOverrides
  ) => MixinBuilder<S, E, EOverrides & NewEOverrides, CPayloads, COverrides, Selectors, Registry>;

  selectors: <NewSelectors extends SelectorsMap<S>>(
    selectors: NewSelectors
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides, Selectors & NewSelectors, Registry>;

  commands: <NewC extends Record<string, RedemeineCommandDefinition<S>>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => NewC
  ) => MixinBuilder<S, E, EOverrides, CPayloads & MapCommandsToPayloads<NewC>, COverrides, Selectors, Registry>;

  entityList: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>, const PK extends string | readonly string[] = 'id'>(
    name: EN,
    entityComponent: T,
    options?: EntityListOptions<PK>,
    mountOverrides?: EntityMountOverrides
  ) => MixinBuilder<S, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, Registry & { [K in EN]: MixinEntityRegistryListEntry<T, PK> }>;

  entityMap: <EN extends string, Keys extends string, T extends EntityPackage<any, any, any, any, any, any>>(
    name: EN,
    entityComponent: T,
    options?: EntityMapOptions<Keys>,
    mountOverrides?: EntityMountOverrides
  ) => MixinBuilder<S, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, Registry & { [K in EN]: MixinEntityRegistryMapEntry<T, Keys> }>;

  valueObjectList: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides, Selectors, Registry & { [K in VOName]: MixinEntityRegistryValueObjectListEntry }>;

  valueObjectMap: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides, Selectors, Registry & { [K in VOName]: MixinEntityRegistryValueObjectMapEntry }>;

  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors, Registry>;

  build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides, Selectors, Registry>;
}

export function createMixin<S>(): MixinBuilder<S> {
  const component = createComponentBehaviorState<S>();
  const mountedEntities: MountedEntityPackage[] = [];

  const builder = bindFluentMethods({}, {
    events: (events: Record<string, Function>) => component.addEvents(events),
    overrideEventNames: (overrides: Record<string, string>) => component.addEventOverrides(overrides),
    selectors: (selectors: Record<string, Function>) => component.addSelectors(selectors),
    commands: (factory: GenericCommandFactory) => component.addCommandsFactory(factory),
    overrideCommandNames: (overrides: Record<string, string>) => component.addCommandOverrides(overrides)
  });

  Object.assign(builder, {
    entityList: <const PK extends string | readonly string[]>(entityName: string, entityComponent: EntityPackage<unknown, string>, options?: EntityListOptions<PK>, mountOverrides?: EntityMountOverrides) => {
      mountedEntities.push({ name: entityName, kind: 'list', component: entityComponent, mountOverrides, pk: options?.pk || 'id' });
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

    build: () => {
      const snapshot = component.getSnapshot();
      const {
        mergedEvents,
        mergedEventOverrides,
        mergedCommandOverrides,
        mounts,
        commandFactory
      } = composeMountedComponentBehavior(mountedEntities, snapshot, component.getCommandsFactory());

      return {
        events: mergedEvents,
        projectors: mergedEvents,
        commands: {} as unknown as GenericCommandMap,
        eventOverrides: mergedEventOverrides,
        selectors: snapshot.selectors,
        commandFactory,
        commandOverrides: mergedCommandOverrides,
        mounts,
        mountedEntities: [...mountedEntities]
      };
    }
  });
  return builder as unknown as MixinBuilder<S>;
}
