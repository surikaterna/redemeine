import { Commands } from './createCommand';

type ProjectorFunction<S = any, E = any> = (state: S, event: E) => void;

export type AggregateProjectors<State, PF extends Commands> = {
  [K in keyof PF]: ProjectorFunction<State, PF[K]>;
};

type CommandFunction<AA extends AggregateProjectors<S>, S = any, E = any> = (state: S, event: E, aggregate: Aggregate<S, AA>) => Event | Event[];

export type AggregateCommands<State, AA extends AggregateProjectors<State>> = {
  [K: string]: CommandFunction<AA, State, any>;
};

export interface AggregateDefinition<State = any> {
  name: string;
  initialState: State | (() => State);
  // commands?: AggregateCommands<State, AggregateProjectors<State>>;
  events: AggregateProjectors<State>;
}

type WrappedApplyFunction<A = any> = (action: A) => void;

export interface Aggregate<State = any, Projectors extends AggregateProjectors<State> = AggregateProjectors<State>, Name extends string = string> {
  name: Name;
  projectors: Projectors;
}

const wrapApplyer = <S, A>(applyer: ProjectorFunction<S, A>) => {
  return (a: A) => {
    applyer(null as S, a);
  };
};

const createAggregate = <State, Projectors extends AggregateProjectors<State, any>>(def: AggregateDefinition<State>): Aggregate<State, Projectors> => {
  const res = Object.keys(def.events).map((key) => {
    return { [key]: wrapApplyer(def.events[key]) };
  });
  const initialState = def.initialState;
  const { name } = def;
  const projectors: Record<string, ProjectorFunction> = {};
  const projectorNames = Object.keys(def.events);
  projectorNames.forEach((projectorName) => {
    projectors[projectorName] = def.events[projectorName];
  });

  return {
    name,
    projectors
  };
};

export { createAggregate };
