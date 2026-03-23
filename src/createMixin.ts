import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap, MapCommandsToPayloads, PackedCommand } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled reusable piece of domain logic (Commands, Events, Selectors)
 * ready to be embedded horizontally into an AggregateBuilder via `.mixins()`.
 */
export interface MixinPackage<S, E = any, EOverrides = any, CPayloads = any, COverrides = any, Selectors = any> {
  events: E;
  eventOverrides: EOverrides;
  commandFactory: (emit: any, context: { selectors: SelectorsMap<S> }) => any;
  commandOverrides: COverrides;
  selectors: SelectorsMap<S>;
}

export interface MixinBuilder<S, E = {}, EOverrides = {}, CPayloads = {}, COverrides = {}, Selectors = {}> {
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

  commands: <NewC extends Record<string, ((state: ReadonlyDeep<S>, ...args: any[]) => Event<any, any> | Event<any, any>[]) | PackedCommand<S, any, any>>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => NewC
  ) => MixinBuilder<S, E, EOverrides, CPayloads & MapCommandsToPayloads<NewC>, COverrides, Selectors>;

  overrideCommandNames: <NewCOverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: NewCOverrides
  ) => MixinBuilder<S, E, EOverrides, CPayloads, COverrides & NewCOverrides, Selectors>;

  build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides, Selectors>;
}

export function createMixin<S>(): MixinBuilder<S> {
  let _events: Record<string, Function> = {};
  let _eventOverrides: Record<string, string> = {};
  let _selectors: SelectorsMap<any> = {};
  let _commandFactories: Function[] = [];
  let _commandOverrides: Record<string, string> = {};

  const builder: any = {
    events: (events: any) => {
      Object.assign(_events, events);
      return builder;
    },
    overrideEventNames: (overrides: any) => {
      Object.assign(_eventOverrides, overrides);
      return builder;
    },
    selectors: (selectors: any) => {
      Object.assign(_selectors, selectors);
      return builder;
    },
    commands: (factory: any) => {
      _commandFactories.push(factory);
      return builder;
    },
    overrideCommandNames: (overrides: any) => {
      Object.assign(_commandOverrides, overrides);
      return builder;
    },
    build: () => {
      const mergedCommandFactory = (emit: any, context: any) => {
        const result: any = {};
        for (const factory of _commandFactories) {
          Object.assign(result, factory(emit, context));
        }
        return result;
      };
      return {
        events: _events,
        eventOverrides: _eventOverrides,
        selectors: _selectors,
        commandFactory: mergedCommandFactory,
        commandOverrides: _commandOverrides
      };
    }
  };
  return builder;
}
