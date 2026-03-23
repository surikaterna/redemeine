import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap, MapCommandsToPayloads } from './types';
import { RedemeineComponent, RedemeineCommandDefinition, GenericCommandFactory, GenericCommandMap, createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled Entity ready to be injected into an AggregateBuilder via `.entities()`.
 * Maintains its own namespace and isolated lifecycle logic.
 */
export interface EntityPackage<S, Name extends string, E = any, EOverrides extends object = {}, CPayloads = any, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>>
  extends RedemeineComponent<S, CPayloads, E, E, Selectors, EOverrides, COverrides> {
  name: Name;
  events: E;
  projectors: E;
  commands: CPayloads;
  eventOverrides: EOverrides;
  selectors: Selectors;
  commandFactory: GenericCommandFactory;
  commandOverrides: COverrides;
}

// 2. The Chaining Interfaces to guide the IDE
export interface EntityBuilder<S, Name extends string, E = {}, EOverrides extends object = {}, CPayloads = {}, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>> {
  /**
   * Register state-altering event handlers for this Entity.
   * **Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
   * The targeted auto-namer maps camelCase keys to dot notation combined with the parent aggregate's namespace (e.g. `aggregate.entity.item_added.event`).
   */
  events: <NewE extends Record<string, (state: S, event: Event<any, any>) => void>>(
    events: NewE
  ) => EntityBuilder<S, Name, E & NewE, EOverrides, CPayloads, COverrides, Selectors>;

  /**
   * Overrides generated event names for this entity.
   */
  overrideEventNames: <NewEOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: NewEOverrides
  ) => EntityBuilder<S, Name, E, EOverrides & NewEOverrides, CPayloads, COverrides, Selectors>;

  /**
   * Define pure functions scoped only to this entity's structure.
   */
  selectors: <NewSelectors extends SelectorsMap<S>>(
    selectors: NewSelectors
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides, Selectors & NewSelectors>;

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
  commands: <C extends Record<string, RedemeineCommandDefinition<S>>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => C
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads & MapCommandsToPayloads<C>, COverrides, Selectors>;

  /**
   * Overrides generated command names for this entity.
   */
  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => EntityBuilder<S, Name, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors>;

  /**
   * Finalizes and compiles the Entity into a pluggable package.
   */
  build: () => EntityPackage<S, Name, E, EOverrides, CPayloads, COverrides, Selectors>;
}

export type EntityEventsStage<S, Name extends string> = EntityBuilder<S, Name>;
export type EntityEventOverridesStage<S, Name extends string, E> = EntityBuilder<S, Name, E>;
export type EntitySelectorsStage<S, Name extends string, E, EOverrides extends object> = EntityBuilder<S, Name, E, EOverrides>;
export type EntityCommandsStage<S, Name extends string, E, EOverrides extends object, Selectors extends SelectorsMap<S>> = EntityBuilder<S, Name, E, EOverrides, {}, {}, Selectors>;
export type EntityCommandOverridesStage<S, Name extends string, E, EOverrides extends object, CPayloads, Selectors extends SelectorsMap<S>> = EntityBuilder<S, Name, E, EOverrides, CPayloads, {}, Selectors>;

// 3. The Implementation
/**
 * Bootstraps a new cohesive domain Entity. 
 * An entity encapsulates state, scoped selectors, events, and commands, to be injected into an AggregateBuilder.
 */
export function createEntity<S, Name extends string>(name: Name): EntityEventsStage<S, Name> {
  const component = createComponentBehaviorState<S>();

  const builder = bindFluentMethods({}, {
    events: (events: Record<string, Function>) => component.addEvents(events),
    overrideEventNames: (overrides: Record<string, string>) => component.addEventOverrides(overrides),
    selectors: (selectors: Record<string, Function>) => component.addSelectors(selectors),
    commands: (factory: GenericCommandFactory) => component.addCommandsFactory(factory),
    overrideCommandNames: (overrides: Record<string, string>) => component.addCommandOverrides(overrides)
  });

  Object.assign(builder, {
    build: () => {
      const snapshot = component.getSnapshot();
      return {
        name,
        events: snapshot.events,
        projectors: snapshot.events,
        commands: {} as unknown as GenericCommandMap,
        eventOverrides: snapshot.eventOverrides,
        selectors: snapshot.selectors,
        commandFactory: component.getCommandsFactory(),
        commandOverrides: snapshot.commandOverrides,
      };
    }
  });

  return builder as unknown as EntityBuilder<S, Name>;
}

