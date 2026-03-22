import { Event, EventEmitterFactory, EventType, CommandType, SelectorsMap } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// 1. The final "Baked" object that goes into the Aggregate
/**
 * A compiled reusable piece of domain logic (Commands, Events, Selectors)
 * ready to be embedded horizontally into an AggregateBuilder via `.mixins()`.
 */
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
/**
 * Staged builder interface enabling fluent chaining of Mixin event handlers.
 * Permits Immer-backed state mutations within handlers.
 */
export interface MixinEventsStage<S> {
  /**
   * Register event handlers for this Mixin that apply state mutations.
   * **Magic:** The `state` object inside these handlers is wrapped in Immer. You CAN mutate it directly!
   * The auto-namer maps camelCase keys to dot notation automatically.
   * 
   * @example
   * .events({
   *   auditLogged: (state, event) => { state.auditTrail.push(event.payload); }
   * })
   */
  events: <E extends Record<string, (state: any, event: Event<any, any>) => void>>(
    events: E
  ) => MixinEventOverridesStage<S, E>;
}

/**
 * Staged builder interface bridging Mixin events to naming overrides.
 */
export interface MixinEventOverridesStage<S, E> {
  /**
   * Staged builder interface bridging Mixin events to naming overrides.
   */
  overrideEventNames: <EOverrides extends Partial<Record<keyof E, EventType>>>(
    overrides: EOverrides
  ) => MixinSelectorsStage<S, E, EOverrides>;
}

/**
 * Staged builder interface bridging Mixin naming overrides to selector configuration.
 */
export interface MixinSelectorsStage<S, E, EOverrides> {
  /**
   * Define pure functions that slice and read from the state.
   * 
   * @example
   * .selectors({ getAuditCount: (state) => state.auditTrail.length })
   */
  selectors: <Selectors extends SelectorsMap<S>>(
    selectors: Selectors
  ) => MixinCommandsStage<S, E, EOverrides, Selectors>;
}

/**
 * Staged builder interface enabling fluent chaining of Mixin command processors.
 * Enforces Readonly state structures within the processors.
 */
export interface MixinCommandsStage<S, E, EOverrides, Selectors> {
  /**
   * Define command processors containing business rules.
   * **Magic:** The `state` provided here is strictly `ReadonlyDeep`. State MUST NOT be mutated in commands, only within `.events()`.
   * 
   * @example
   * .commands((emit, ctx) => ({
   *   logAudit: (state, payload: { msg: string }) => emit('auditLogged', payload)
   * }))
   */
  commands: <CPayloads extends Record<string, any>>(
    factory: (emit: EventEmitterFactory<string, E, EOverrides>, context: { selectors: Selectors }) => {
      [K in keyof CPayloads]: (state: ReadonlyDeep<S>, payload: CPayloads[K]) => Event<any, any> | Event<any, any>[];
    }
  ) => MixinCommandOverridesStage<S, E, EOverrides, CPayloads, Selectors>;
}

/**
 * Staged builder interface bridging Mixin command configuration to finalize the build.
 */
export interface MixinCommandOverridesStage<S, E, EOverrides, CPayloads, Selectors> {
  overrideCommandNames: <COverrides extends Partial<Record<keyof CPayloads, CommandType>>>(
    overrides: COverrides
  ) => {
    /**
     * Finalizes and compiles the Mixin.
     */
    build: () => MixinPackage<S, E, EOverrides, CPayloads, COverrides, Selectors>;
  };
}

// 3. The Implementation
/**
 * Bootstraps a new cohesive Domain Mixin. 
 * Allows creating horizontally resuable chunks or policies to layer onto different aggregates (e.g. AuditLog, Assignable).
 */
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