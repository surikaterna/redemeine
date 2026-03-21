import { Event, EventEmitterFactory, EventType, CommandType } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// 1. The final "Baked" object that goes into the Aggregate
export interface MixinPackage<S, E = any, EOverrides = any, CPayloads = any, COverrides = any> {
  events: E;
  eventOverrides: EOverrides;
  commandFactory: (emit: any) => {
    [K in keyof CPayloads]: (state: ReadonlyDeep<S>, payload: CPayloads[K]) => Event<any, any> | Event<any, any>[];
  };
  commandOverrides: COverrides;
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
  ) => MixinCommandsStage<S, E, EOverrides>;
}

export interface MixinCommandsStage<S, E, EOverrides> {
  commands: <CPayloads extends Record<string, any>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>) => {
      [K in keyof CPayloads]: (state: ReadonlyDeep<S>, payload: CPayloads[K]) => Event<any, any> | Event<any, any>[];
    }
  ) => MixinCommandOverridesStage<S, E, EOverrides, CPayloads>;
}

export interface MixinCommandOverridesStage<S, E, EOverrides, CPayloads> {
  overrideCommandNames: <COverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: COverrides
  ) => {
    build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides>;
  };
}

// 3. The Implementation
export function createMixin<S>(): MixinEventsStage<S> {
  return {
    events: (events) => ({
      overrideEventNames: (eventOverrides) => ({
        commands: (commandFactory) => ({
          overrideCommandNames: (commandOverrides) => ({
            build: () => ({
              events,
              eventOverrides,
              commandFactory: commandFactory as any,
              commandOverrides,
            })
          })
        })
      })
    })
  };
}