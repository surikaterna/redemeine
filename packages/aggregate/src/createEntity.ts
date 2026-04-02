import { Event, EventType, CommandType, SelectorsMap, CommandContext, CommandIntents } from '@redemeine/kernel';
import { RedemeineComponent, RedemeineCommandDefinition, RedemeineEventDefinition, NormalizeEventDefinitions, GenericCommandFactory, GenericCommandMap, createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';
import type { EventEmitterFactory, MapCommandsToPayloads } from './types/aggregateTyping';
import {
  MapEntityCommands,
  EntityListOptions,
  EntityMapOptions,
  EntityMountOverrides,
  MountedStructureMetadata as EntityMountedStructureMetadata,
  MountedEntityPackage,
  composeMountedComponentBehavior
} from './componentMounts';

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled Entity ready to be injected into an AggregateBuilder via `.entities()`.
 * Maintains its own namespace and isolated lifecycle logic.
 */
export interface EntityPackage<S, Name extends string, E = any, EOverrides extends object = {}, CPayloads = any, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>>
  extends RedemeineComponent<S, CPayloads, E, E, Selectors, EOverrides, COverrides> {
  name: Name;
  events: E;
  projectors: E;
  commands: CPayloads;
  eventOverrides: EOverrides;
  selectors: Selectors;
  commandFactory: GenericCommandFactory;
  commandOverrides: COverrides;
  eventMetadata: Record<string, TMeta | undefined>;
  mounts: Record<string, EntityMountedStructureMetadata>;
  mountedEntities: MountedEntityPackage[];
}

// 2. The Chaining Interfaces to guide the IDE
export interface EntityBuilder<S, Name extends string, E = {}, EOverrides extends object = {}, CPayloads = {}, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Register state-altering event handlers for this Entity.
   * **Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
   * The targeted auto-namer maps camelCase keys to dot notation combined with the parent aggregate's namespace (e.g. `aggregate.entity.item_added.event`).
   */
  events: <NewE extends Record<string, RedemeineEventDefinition<S, TMeta>>>(
    events: NewE
  ) => EntityBuilder<S, Name, E & NormalizeEventDefinitions<NewE>, EOverrides, CPayloads, COverrides, Selectors, TMeta>;

  /**
   * Overrides generated event names for this entity.
   */
  overrideEventNames: <NewEOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: NewEOverrides
  ) => EntityBuilder<S, Name, E, EOverrides & NewEOverrides, CPayloads, COverrides, Selectors, TMeta>;

  /**
   * Define pure functions scoped only to this entity's structure.
   */
  selectors: <NewSelectors extends SelectorsMap<S>>(
    selectors: NewSelectors
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors & NewSelectors, TMeta>;

  /**
   * Define scoped command processors that execute business logic.
   * **Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands.
   * The auto-namer evaluates camelCase keys with the entity's namespace (e.g. `cancelLine` -> `aggregate.entity.cancel_line.command`).
   * 
   * @example
   * .commands((emit, ctx) => ({
   *   cancelLine: (state, payload: { reason: string }) => {
   *      if (ctx.selectors.isLineValid(state)) return emit('lineCancelled', payload);
   *      throw new Error("Invalid");
   *   }
   * }))
   */
  commands: <C extends Record<string, RedemeineCommandDefinition<S, TMeta>>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors; commands: CommandContext<CommandIntents<CPayloads>> }) => C
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapCommandsToPayloads<C>, COverrides, Selectors, TMeta>;

  /**
   * Register a list-backed nested entity collection.
   */
  entityList: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>, const PK extends string | readonly string[] = 'id'>(
    name: EN,
    entityComponent: T,
    options?: EntityListOptions<PK>,
    mountOverrides?: EntityMountOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, TMeta>;

  /**
   * Register a record-backed nested entity map.
   */
  entityMap: <EN extends string, Keys extends string, T extends EntityPackage<any, any, any, any, any, any>>(
    name: EN,
    entityComponent: T,
    options?: EntityMapOptions<Keys>,
    mountOverrides?: EntityMountOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, TMeta>;

  /**
   * Register a read-only nested value object list branch.
   */
  valueObjectList: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta>;

  /**
   * Register a read-only nested value object map branch.
   */
  valueObjectMap: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta>;

  /**
   * Overrides generated command names for this entity.
   */
  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors, TMeta>;

  /**
   * Finalizes and compiles the Entity into a pluggable package.
   */
  build: () => EntityPackage<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta>;
}

export type EntityEventsStage<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, {}, {}, {}, {}, SelectorsMap<S>, TMeta>;
export type EntityEventOverridesStage<S, Name extends string, E, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, {}, {}, {}, SelectorsMap<S>, TMeta>;
export type EntitySelectorsStage<S, Name extends string, E, EOverrides extends object, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, {}, {}, SelectorsMap<S>, TMeta>;
export type EntityCommandsStage<S, Name extends string, E, EOverrides extends object, Selectors extends SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, {}, {}, Selectors, TMeta>;
export type EntityCommandOverridesStage<S, Name extends string, E, EOverrides extends object, CPayloads, Selectors extends SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, CPayloads, {}, Selectors, TMeta>;

// 3. The Implementation
/**
 * Bootstraps a new cohesive domain Entity. 
 * An entity encapsulates state, scoped selectors, events, and commands, to be injected into an AggregateBuilder.
 */
export function createEntity<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>>(name: Name): EntityEventsStage<S, Name, TMeta> {
  const component = createComponentBehaviorState<S>();
  const mountedEntities: MountedEntityPackage[] = [];

  const builder = bindFluentMethods({}, {
    events: (events: Record<string, RedemeineEventDefinition<S, TMeta>>) => component.addEvents(events as Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>),
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
        mergedEventMetadata,
        mergedEventOverrides,
        mergedCommandOverrides,
        mounts,
        commandFactory
      } = composeMountedComponentBehavior(mountedEntities, snapshot, component.getCommandsFactory());

        return {
        name,
        events: mergedEvents,
        projectors: mergedEvents,
        commands: {} as unknown as GenericCommandMap,
          eventOverrides: mergedEventOverrides,
        selectors: snapshot.selectors,
          commandFactory,
          commandOverrides: mergedCommandOverrides,
          eventMetadata: mergedEventMetadata as Record<string, TMeta | undefined>,
          mounts,
          mountedEntities: [...mountedEntities],
        };
    }
  });

  return builder as unknown as EntityBuilder<S, Name, {}, {}, {}, {}, SelectorsMap<S>, TMeta>;
}

