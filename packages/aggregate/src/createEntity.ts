import { type Event, type EventType, type CommandType, type SelectorsMap, type CommandContext, type CommandIntents } from '@redemeine/kernel';
import type { RedemeineComponent, RedemeineCommandDefinition, RedemeineEventDefinition, NormalizeEventDefinitions, GenericCommandFactory, GenericCommandMap, AnyFunction } from './redemeineComponent';
import { createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';
import type { EventEmitterFactory, MapCommandsToPayloads, EntityCommandDefinition, NormalizeEntityCommands, ValidEntityCommandDefinitions } from './types/aggregateTyping';
import { entityCommands } from './entityCommandLifecycle';
import type { AggregateStateView } from './types/aggregateState';
import type { ReplaceCommandMap, AggregateEntityRegistry, EntityRegistryListEntry, MountSemanticName } from './types/entityMount';
import type {
  MapEntityCommands,
  EntityListOptions,
  EntityMapOptions,
  EntityMountOverrides,
  MountedStructureMetadata as EntityMountedStructureMetadata,
  MountedEntityPackage,
} from './componentMounts';
import { composeMountedComponentBehavior, createMountMethods } from './componentMounts';

type EntityCommandDescriptors<C, Static extends string> = {
  [K in keyof C]: MapCommandsToPayloads<NormalizeEntityCommands<C>>[K] &
    (K extends Static ? { readonly __staticCommand: true } : {});
};

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled Entity ready to be injected into an AggregateBuilder via `.entities()`.
 * Maintains its own namespace and isolated lifecycle logic.
 */
export interface EntityPackage<S, Name extends string, E extends Record<string, any> = Record<string, any>, EOverrides extends object = {}, CPayloads extends Record<string, any> = Record<string, any>, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>, Registry extends AggregateEntityRegistry = {}>
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
  readonly initialState?: AggregateStateView<S> & object;
  readonly __registryType?: Registry;
}

// 2. The Chaining Interfaces to guide the IDE
export interface EntityBuilder<S, Name extends string, E extends Record<string, any> = {}, EOverrides extends object = {}, CPayloads extends Record<string, any> = {}, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>, Registry extends AggregateEntityRegistry = {}> {
  /**
   * Register state-altering event handlers for this Entity.
   * **Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
   * The default auto-namer maps camelCase keys to snake_case combined with the parent aggregate's namespace (e.g. `aggregate.entity.item_added.event`).
   */
  events: <NewE extends Record<string, RedemeineEventDefinition<S, TMeta>>>(
    events: NewE
  ) => EntityBuilder<S, Name, E & NormalizeEventDefinitions<NewE>, EOverrides, CPayloads, COverrides, Selectors, TMeta, Registry>;

  /**
   * Overrides generated event names for this entity.
   */
  overrideEventNames: <NewEOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: NewEOverrides
  ) => EntityBuilder<S, Name, E, EOverrides & NewEOverrides, CPayloads, COverrides, Selectors, TMeta, Registry>;

  /**
   * Define pure functions scoped only to this entity's structure.
   */
  selectors: <NewSelectors extends SelectorsMap<S>>(
    selectors: NewSelectors
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors & NewSelectors, TMeta, Registry>;

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
  commands: <C extends Record<string, EntityCommandDefinition<S, TMeta>> & ValidEntityCommandDefinitions<C>, const Static extends readonly (NoInfer<keyof C> & string)[] = readonly []>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors; commands: CommandContext<CommandIntents<CPayloads>> }) => C,
    options?: { static: Static }
  ) => EntityBuilder<S, Name, E, EOverrides, ReplaceCommandMap<CPayloads, EntityCommandDescriptors<C, Static[number]>>, COverrides, Selectors, TMeta, Registry>;

  /**
   * Register a list-backed nested entity collection.
   */
  entityList: <EN extends string, T extends EntityPackage<any, any, any, any, any, any>, const PK extends string | readonly string[] = 'id', const Overrides extends [mountOverrides?: EntityMountOverrides | undefined] = [mountOverrides?: EntityMountOverrides | undefined]>(
    name: EN,
    entityComponent: T,
    options?: EntityListOptions<PK>,
    ...mountOverrides: Overrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, TMeta, ReplaceCommandMap<Registry, { [K in EN]: EntityRegistryListEntry<T, PK, MountSemanticName<T['name'], Overrides[0]>> }>>;

  /**
   * Register a record-backed nested entity map.
   */
  entityMap: <EN extends string, Keys extends string, T extends EntityPackage<any, any, any, any, any, any>>(
    name: EN,
    entityComponent: T,
    options?: EntityMapOptions<Keys>,
    mountOverrides?: EntityMountOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapEntityCommands<EN, T extends EntityPackage<any, any, any, any, infer SubCPayloads, any> ? SubCPayloads : {}>, COverrides, Selectors, TMeta, Registry>;

  /**
   * Register a read-only nested value object list branch.
   */
  valueObjectList: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta, Registry>;

  /**
   * Register a read-only nested value object map branch.
   */
  valueObjectMap: <VOName extends string>(
    name: VOName,
    schema?: unknown
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta, Registry>;

  /**
   * Overrides generated command names for this entity.
   */
  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors, TMeta, Registry>;

  /**
   * Finalizes and compiles the Entity into a pluggable package.
   */
  build: () => EntityPackage<S, Name, E, EOverrides, CPayloads, COverrides, Selectors, TMeta, Registry>;
}

export type EntityEventsStage<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, {}, {}, {}, {}, SelectorsMap<S>, TMeta>;
export type EntityEventOverridesStage<S, Name extends string, E extends Record<string, any>, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, {}, {}, {}, SelectorsMap<S>, TMeta>;
export type EntitySelectorsStage<S, Name extends string, E extends Record<string, any>, EOverrides extends object, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, {}, {}, SelectorsMap<S>, TMeta>;
export type EntityCommandsStage<S, Name extends string, E extends Record<string, any>, EOverrides extends object, Selectors extends SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, {}, {}, Selectors, TMeta>;
export type EntityCommandOverridesStage<S, Name extends string, E extends Record<string, any>, EOverrides extends object, CPayloads extends Record<string, any>, Selectors extends SelectorsMap<S>, TMeta extends Record<string, unknown> = Record<string, unknown>> = EntityBuilder<S, Name, E, EOverrides, CPayloads, {}, Selectors, TMeta>;

// 3. The Implementation
/**
 * Bootstraps a new cohesive domain Entity. 
 * An entity encapsulates state, scoped selectors, events, and commands, to be injected into an AggregateBuilder.
 */
export function createEntity<S, Name extends string, TMeta extends Record<string, unknown> = Record<string, unknown>>(name: Name, ...templates: [initialState?: S]): EntityEventsStage<S, Name, TMeta> {
  const [initialState] = templates;
  if (initialState !== undefined && (!initialState || typeof initialState !== 'object' || Array.isArray(initialState))) {
    throw new TypeError('Entity initial state must be an object');
  }
  const component = createComponentBehaviorState<S>();
  const mountedEntities: MountedEntityPackage[] = [];
  const builder = bindFluentMethods({}, {
    events: (events: Record<string, RedemeineEventDefinition<S, TMeta>>) => component.addEvents(events as Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>),
    overrideEventNames: (overrides: Record<string, string>) => component.addEventOverrides(overrides),
    selectors: (selectors: Record<string, AnyFunction>) => component.addSelectors(selectors),
    commands: (factory: GenericCommandFactory, options?: { static: readonly string[] }) =>
      component.addCommandsFactory(entityCommands(factory, options?.static ?? [], initialState !== undefined)),
    overrideCommandNames: (overrides: Record<string, string>) => component.addCommandOverrides(overrides)
  });
  createMountMethods(builder, mountedEntities);
  Object.assign(builder, {
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
        ...(initialState === undefined ? {} : { initialState }),
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
