import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap, MapCommandsToPayloads } from './types';
import { RedemeineComponent, RedemeineCommandDefinition, GenericCommandFactory, GenericCommandMap, createComponentBehaviorState, bindFluentMethods } from './redemeineComponent';

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled reusable piece of domain logic (Commands, Events, Selectors)
 * ready to be embedded horizontally into an AggregateBuilder via `.mixins()`.
 */
export interface MixinPackage<S, E = any, EOverrides extends object = {}, CPayloads = any, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>>
  extends RedemeineComponent<S, CPayloads, E, E, Selectors, EOverrides, COverrides> {
  events: E;
  projectors: E;
  commands: CPayloads;
  eventOverrides: EOverrides;
  commandFactory: GenericCommandFactory;
  commandOverrides: COverrides;
  selectors: Selectors;
}

export interface MixinBuilder<S, E = {}, EOverrides extends object = {}, CPayloads = {}, COverrides extends object = {}, Selectors extends SelectorsMap<S> = SelectorsMap<S>> {
  /**
   * Register event handlers for this Mixin that apply state mutations.
   */
  events: <NewE extends Record<string, (state: S, event: Event<any, any>) => void>>(
    events: NewE
  ) => MixinBuilder<S, E & NewE, EOverrides, CPayloads, COverrides, Selectors>;

  overrideEventNames: <NewEOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: NewEOverrides
  ) => MixinBuilder<S, E, EOverrides & NewEOverrides, CPayloads, COverrides, Selectors>;

  selectors: <NewSelectors extends SelectorsMap<S>>(
    selectors: NewSelectors
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides, Selectors & NewSelectors>;

  commands: <NewC extends Record<string, RedemeineCommandDefinition<S>>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => NewC
  ) => MixinBuilder<S, E, EOverrides, CPayloads & MapCommandsToPayloads<NewC>, COverrides, Selectors>;

  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors>;

  build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides, Selectors>;
}

export function createMixin<S>(): MixinBuilder<S> {
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
        events: snapshot.events,
        projectors: snapshot.events,
        commands: {} as unknown as GenericCommandMap,
        eventOverrides: snapshot.eventOverrides,
        selectors: snapshot.selectors,
        commandFactory: component.getCommandsFactory(),
        commandOverrides: snapshot.commandOverrides
      };
    }
  });
  return builder as unknown as MixinBuilder<S>;
}
