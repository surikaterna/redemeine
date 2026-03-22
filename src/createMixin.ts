import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// 1. The final "Baked" object that goes into the Aggregate
export interface MixinPackage<S, E = any, EOverrides = any, CPayloads = any, COverrides = any, Selectors = any> {
  events: E;
  eventOverrides: EOverrides;
  commandFactory: (emit: any, context: { selectors: SelectorsMap<S> }) => {
    [K in keyof CPayloads]: (state: ReadonlyDeep<S>, payload: CPayloads[K]) => Event<any, any> | Event<any, any>[];
  };
  commandOverrides: COverrides;
  selectors: SelectorsMap<S>;
}

// 2. The Chaining Interfaces to guide the IDE
export interface MixinEventsStage<S> {
  events: <E extends Record<string, (state: any, event: Event<any, any>) => void>>(
    events: E
  ) => MixinEventOverridesStage<S, E>;
}

export interface MixinEventOverridesStage<S, E> {
  overrideEventNames: <EOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: EOverrides
  ) => MixinSelectorsStage<S, E, EOverrides>;
}

export interface MixinSelectorsStage<S, E, EOverrides> {
  selectors: <Selectors extends SelectorsMap<S>>(
    selectors: Selectors
  ) => MixinCommandsStage<S, E, EOverrides, Selectors>;
}

export interface MixinCommandsStage<S, E, EOverrides, Selectors> {
  commands: <CPayloads extends Record<string, any>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => {
      [K in keyof CPayloads]: (state: ReadonlyDeep<S>, payload: CPayloads[K]) => Event<any, any> | Event<any, any>[];
    }
  ) => MixinCommandOverridesStage<S, E, EOverrides, CPayloads, Selectors>;
}

export interface MixinCommandOverridesStage<S, E, EOverrides, CPayloads, Selectors> {
  overrideCommandNames: <COverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: COverrides
  ) => {
    build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides, Selectors>;
  };
}

// 3. The Implementation
export function createMixin<S>(): MixinEventsStage<S> {
  return {
    events: (events) => ({
      overrideEventNames: (eventOverrides) => ({
        selectors: (selectors) => ({
          commands: (commandFactory) => ({
            overrideCommandNames: (commandOverrides) => ({
              build: () => ({
                events,
                eventOverrides,
                commandFactory: commandFactory as any,
                commandOverrides,
                selectors
              })
            })
          })
        })
      })
    })
  };
}