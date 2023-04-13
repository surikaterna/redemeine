import { Command, Commands } from './createCommand';
import { Event } from './createEvent';
import { Merge } from './utils/types/Merge';
import { type NestedPairsOf } from './utils/types/NestedPairOf';

// Flow of things
// (cmd func) -> command -> (process) -> event -> project(apply) -> state

// Events
type EventWithCommand<S, P, E extends Event<P> = Event<P>> = {
  project: (state1: S, event: E) => void;
};
// & {
//   [K in Exclude<keyof ES, 'project'>]: undefined | ((state2: S, ...any: never[]) => E|void);
// };

type EventOrEventCommand<S, P extends any = any, E extends Event<P> = Event<P>> = EventWithCommand<S, P, E> | ((state: S, event: E) => void);

type Events<S, T extends keyof any = string, P extends any = any> = Record<T, EventOrEventCommand<S, P>>;
export type AggregateCommandsDeclaration<S, C extends Record<string, (...args: any) => any>, E extends Events<S, any> = Events<S, any>> = {
  // [K in keyof C]: (a: string) => ReturnType<C[K]>;
} & Merge<Exclude<NestedPairsOf<E, Function>, { project: Function }>>;

type ValidateEventSpecification<S, ES extends Events<S, any>> = ES & {
  [T in keyof ES]: ES[T] extends {
    project(state3: S, event: infer E extends Event): void;
  }
    ? {
        // [K in Exclude<keyof ES[T], 'project'>]: (state4: S, command: Command) => E;
      }
    : {};
};

export type AggregateSpecification<S, C extends Commands<any> = Commands<any>, E extends Events<S> = Events<S>, Name extends string = string> = {
  type: Name;
  initialState: S;
  commands?: C;
  events: E;
};

export type AggregateProjectorsDeclaration<S, E extends Events<S, any> = Events<S, any>> = {
  [K in keyof E]: (
    state: S,
    e: E[K] extends (...any: any) => any ? ReturnType<E[K]> : E[K] extends EventWithCommand<S, any> ? ReturnType<E[K]['project']> : never
  ) => void;
};

export type AggregateDeclaration<S, C extends Commands<any> = Commands<any>, E extends Events<S, any> = Events<S, any>, Name extends string = string> = {
  type: Name;
  initialState: S;
  commands: AggregateCommandsDeclaration<S, C, E>;
  projectors: AggregateProjectorsDeclaration<S, E>;
  events: E;
};
export function createAggregate<S, C extends Commands<any>, E extends Events<S, any>>(spec: AggregateSpecification<S, C, E>): AggregateDeclaration<S, C, E> {
  const res = { commands: {}, projectors: {} };
  const cmd = spec.commands || [];

  /**
   * Create commands
   */
  Object.keys(cmd).forEach((c) => (res.commands[c] = (a: string) => cmd[c]));
  Object.keys(spec.events).forEach((e) => {
    if (typeof e !== 'function') {
      Object.keys(spec.events[e]).forEach((commandKey) => {
        if (commandKey !== 'project') {
          res.commands[commandKey] = spec.events[e][commandKey];
        }
      });
    }
  });

  /**
   * Create projectors
   */
  Object.keys(spec.events).forEach((e) => {
    if (typeof e !== 'function') {
      Object.keys(spec.events[e]).forEach((key) => {
        if (key === 'project') {
          res.projectors[e] = spec.events[e][key];
        }
      });
    }
  });
  return res as AggregateDeclaration<S, C, E>;
}
