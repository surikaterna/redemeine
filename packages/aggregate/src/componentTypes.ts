import type { Event, ReadonlyDeep, SelectorsMap } from '@redemeine/kernel';
import type { Merge } from './types/Merge';
import type { AllKeys } from './types/AllKeys';
import type { ReplaceFirstArg } from './types/ReplaceFirstArg';
import type { GenericCommandFactory } from './commandFactory';

// SAFETY: `any` in Event type params required — projectors accept events with heterogeneous payloads
export type RedemeineEventProjector<S> = (state: S, event: Event<any, any>) => void;
export type RedemeineEventDefinition<S, TMeta extends Record<string, unknown> = Record<string, unknown>> =
  | RedemeineEventProjector<S>
  | {
      projector: RedemeineEventProjector<S>;
      meta?: TMeta;
    };

export type NormalizeEventDefinitions<T extends Record<string, RedemeineEventDefinition<any, any>>> = {
  // SAFETY: `any` in conditional extends clauses required for inference of arbitrary function shapes
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? T[K]
    : T[K] extends { projector: infer P }
      ? Extract<P, (...args: any[]) => any>
      : never;
};

export interface RedemeineComponent<
  S,
  // SAFETY: `any` in generic defaults required for structural subtyping of component unions
  Commands extends Record<string, any> = {},
  Events extends Record<string, any> = {},
  Projectors extends Record<string, any> = {},
  Selectors extends Record<string, any> = {},
  EventOverrides extends object = Record<string, string>,
  CommandOverrides extends object = Record<string, string>
> {
  /**
   * Phantom generic brand to enforce component state compatibility in structural typing.
   */
  readonly __stateType?: S;
  readonly state?: ReadonlyDeep<unknown>;
  readonly commands: Commands;
  readonly events: Events;
  readonly projectors: Projectors;
  readonly selectors: Selectors;
  readonly eventOverrides: EventOverrides;
  readonly commandOverrides: CommandOverrides;
}

// SAFETY: `any` in component type positions required for covariant union extraction
export type ComponentCommandUnion<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  T[number] extends RedemeineComponent<any, infer C, any, any, any> ? C : {};

export type MergeComponentCommands<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  Merge<ComponentCommandUnion<T>>;

export type MergeComponentCommandKeys<T extends readonly RedemeineComponent<any, any, any, any, any>[]> =
  AllKeys<ComponentCommandUnion<T>>;

export type PublicCommandArgsFromDefinition<S, TDef> =
  TDef extends { pack: (...args: infer A) => unknown }
    ? A
    : ReplaceFirstArg<never, Extract<TDef, (state: ReadonlyDeep<S>, ...args: unknown[]) => unknown>> extends (
        state: never,
        ...args: infer A
      ) => unknown
      ? A
      : never;

export type PublicCommandMethodsFromInternal<S, TCommands extends Record<string, unknown>, TResult> = {
  [K in keyof TCommands]: (...args: PublicCommandArgsFromDefinition<S, TCommands[K]>) => TResult;
};

// SAFETY: Using `Function` for event/selector storage because projectors have heterogeneous signatures
// that are incompatible with a single typed function signature due to contravariance.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type AnyFunction = Function;

export interface ComponentBehaviorSnapshot<S> {
  events: Record<string, AnyFunction>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: SelectorsMap<S>;
  commandOverrides: Record<string, string>;
}

export interface InheritableComponentBehavior {
  events: Record<string, AnyFunction>;
  eventMetadata: Record<string, Record<string, unknown> | undefined>;
  eventOverrides: Record<string, string>;
  selectors: Record<string, AnyFunction>;
  commandOverrides: Record<string, string>;
  commandsFactory: GenericCommandFactory;
}
