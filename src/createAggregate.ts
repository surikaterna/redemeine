import { Commands } from './createCommand';

// Flow of things
// func -> command -> (process) -> event -> project(apply) -> state

type ProjectorFunction<S = any, E = any> = (state: S, event: E) => void;

type CommandProcessFunction<S = any, C = any, R = any> = (state: S, command: C) => R;

export type CommandProcessors<State, PF extends Commands> = {
  [K in keyof PF]: CommandProcessFunction<State, PF[K]>;
};

// type CommandFunction<AA extends AggregateProjectors<S>, S = any, E = any> = (state: S, event: E, aggregate: Aggregate<S, AA>) => Event | Event[];

// export type AggregateCommands<State, AA extends AggregateProjectors<State>> = {
//   [K: string]: CommandFunction<AA, State, any>;
// };

export interface AggregateDefinition<
  State = any,
  AggregateProcessors extends CommandProcessors<State, any> = CommandProcessors<State, any>,
  Name extends string = string
> {
  name: Name;
  initialState: State | (() => State);
  // commands?: AggregateCommands<State, AggregateProjectors<State>>;
  commands: AggregateProcessors;
}

type WrappedApplyFunction<A = any> = (action: A) => void;

export interface Aggregate<
  State = any,
  AggregateProcessors extends CommandProcessors<State, any> = CommandProcessors<State, any>,
  Name extends string = string
> {
  name: Name;
  commands: AggregateProcessors;
}

const wrapApplyer = <S, A>(applyer: ProjectorFunction<S, A>) => {
  return (a: A) => {
    applyer(null as S, a);
  };
};

export function createAggregate<State, AggregateProcessors extends CommandProcessors<State, any> = CommandProcessors<State, any>, Name extends string = string>(
  def: AggregateDefinition<State, AggregateProcessors, Name>
): Aggregate<State, AggregateProcessors, Name> {
  // const res = Object.keys(def.events).map((key) => {
  //   return { [key]: wrapApplyer(def.events[key]) };
  // });
  const initialState = def.initialState;
  const { name } = def;
  const commands: Record<string, CommandProcessFunction> = {};
  const projectorNames = Object.keys(def.commands);
  projectorNames.forEach((projectorName) => {
    commands[projectorName] = def.commands[projectorName];
  });

  return {
    name,
    commands: def.commands
  };
}
