import { produce, Draft } from 'immer';
import type { ReadonlyDeep } from 'type-fest';
import { Command, Commands } from './createCommand';
import { Event } from './createEvent';
import { AllKeys } from './utils/types/AllKeys';
import { Merge } from './utils/types/Merge';
import { type NestedPairsOf } from './utils/types/NestedPairOf';

// Flow of things
// (cmd func) -> command -> (process) -> event -> project(apply) -> state

// Events
export type EventWithCommand<S, P, E extends Event<P> = Event<P>, T extends keyof any = string> = {
  project: (state1: Draft<S>, event: E) => void;
};
// & {
//   [K in Exclude<keyof ES, 'project'>]: undefined | ((state2: S, ...any: never[]) => E|void);
// };

export type EventOrEventCommand<S, P extends any = any, E extends Event<P> = Event<P>, T extends keyof any = string> =
  | EventWithCommand<S, P, E, T>
  | ((state: Draft<S>, event: E) => void);

export type Events<S, T extends keyof any = string, P extends any = any> = Record<T, EventOrEventCommand<S, P>>;
type WrapState<S, C> = {
  [K in keyof C]: C[K] extends (s: any, ...args: infer A) => infer R ? (state: S, ...args: A) => R : never;
};

export type AggregateCommandsDeclaration<S, C extends Record<string, (...args: any) => any>, E extends Events<S, any> = Events<S, any>> = {
  [K in keyof C]: C[K] extends (s: any, command: infer Cmd, ...rest: any[]) => infer R ? (state: S, command: Cmd) => R : never;
} & WrapState<S,Merge<Exclude<NestedPairsOf<E, Function>, { project: Function }>>>;

type ValidateEventSpecification<S, ES extends Events<S, any>, Name extends string, InvokeObj> = ES & {
  [T in keyof ES]: ES[T] extends {
    project(state3: Draft<S>, event: infer E extends Event): void;
  }
    ? {
        [K in Exclude<keyof ES[T], 'project'>]: ES[T][K] extends (...args: any) => any ? (state4: ReadonlyDeep<S>, command: Parameters<ES[T][K]>[1], emit: EventCreators<Name, ES>, invoke: InvokeObj) => E | Event | Event[] : never;
      }
    : {};
};

type ExtractEventPayload<E> = E extends Event<infer P, any> ? P : never;

type ExtractProjectorEvent<E> = 
  E extends { project: (state: any, event: infer Ev) => any } ? Ev : 
  E extends (state: any, event: infer Ev) => any ? Ev : 
  never;

type PayloadOrVoid<P> = [P] extends [void | undefined] ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type ExtractedPayload<E> = ExtractEventPayload<ExtractProjectorEvent<E>>;

type EventCreatorFunc<Name extends string, K extends string, P> = 
  IsAny<P> extends true ? (payload?: any) => Event<any, `${Name}.${K}.event`> :
  [P] extends [void | undefined] ? (payload?: P) => Event<P, `${Name}.${K}.event`> :
  (payload: P) => Event<P, `${Name}.${K}.event`>;

export type EventCreators<Name extends string, E> = {
  [K in keyof E]: EventCreatorFunc<Name, K & string, ExtractedPayload<E[K]>>
};

type RemoveStateArg<Func> = Func extends (state: any, payload: infer P, ...args: any[]) => infer R 
  ? IsAny<P> extends true ? (payload?: any) => R
  : [P] extends [void | undefined] ? (payload?: P) => R
  : (payload: P) => R
  : never;

type InvokeCreators<C> = {
  [K in keyof C]: RemoveStateArg<C[K]>
};

export type RootCommandProcessors<S, Name extends string, E, InvokeObj = any> = Record<string, (state: ReadonlyDeep<S>, command: any, emit: EventCreators<Name, E>, invoke: InvokeObj) => Event | Event[]>;

export type AggregateSpecification<S, C extends RootCommandProcessors<S, Name, E, InvokeCreators<AggregateCommandsDeclaration<S, {}, E>>> = RootCommandProcessors<S, string, Events<S, any>>, E extends Events<S> = Events<S>, Name extends string = string> = {
  type: Name;
  initialState: S;
  commands?: C;
  events: ValidateEventSpecification<S, E, Name, InvokeCreators<AggregateCommandsDeclaration<S, {}, E>>>;
};

export type AggregateProjectorsDeclaration<S, E extends Events<S, any> = Events<S, any>> = {
  [K in keyof E]: (
    state: S,
    // if E[K] is a function use return type
    // else E[K] is eventDef with project property, use return type of that project property, otherwise use nothing
    event: E[K] extends (...any: any) => any
      ? Parameters<E[K]>[1] // or ReturnType ? wait, the event is usually parameter 1
      : E[K] extends EventWithCommand<S, any, infer EV>
      ? EV
      : never
  ) => S;
};

export type AggregateDeclaration<S, C extends RootCommandProcessors<S, Name, E> = RootCommandProcessors<S, string, Events<S, any>>, E extends Events<S, any> = Events<S, any>, Name extends string = string> = {
  type: Name;
  initialState: S;
  commands: AggregateCommandsDeclaration<S, C, E>;
  projectors: AggregateProjectorsDeclaration<S, E>;
  events: E;
};

export function createAggregate<S, C extends RootCommandProcessors<S, Name, E>, E extends Events<S, any>, Name extends string>(spec: AggregateSpecification<S, C, E, Name>): AggregateDeclaration<S, C, E, Name> {
  const res = { commands: {}, projectors: {} } as any;
  const cmd = spec.commands || {};

  const emitObject: any = {};
  Object.keys(spec.events).forEach((e) => {
    emitObject[e] = (payload: any) => ({
      type: `${spec.type}.${e}.event`,
      payload: payload === undefined ? undefined : payload
    });
  });

  const createInvokeObject = (state: any) => {
    const invokeObject: any = {};
    Object.keys(cmd).forEach((c) => {
      invokeObject[c] = (payload: any) => res.commands[c](state, payload);
    });
    Object.keys(spec.events).forEach((e) => {
      const eventDef = spec.events[e];
      if (typeof eventDef !== 'function') {
        Object.keys(eventDef as object).forEach((commandKey) => {
          if (commandKey !== 'project') {
            invokeObject[commandKey] = (payload: any) => res.commands[commandKey](state, payload);
          }
        });
      }
    });
    return invokeObject;
  };

  /**
   * Create commands
   */
  Object.keys(cmd).forEach((c) => {
    res.commands[c] = (state: any, payload: any) => cmd[c](state, payload, emitObject, createInvokeObject(state));
  });
  Object.keys(spec.events).forEach((e) => {
    const eventDef = spec.events[e];
    if (typeof eventDef !== 'function') {
      Object.keys(eventDef as object).forEach((commandKey) => {
        if (commandKey !== 'project') {
          res.commands[commandKey] = (state: any, payload: any) =>
            (eventDef as any)[commandKey](state, payload, emitObject, createInvokeObject(state));
        }
      });
    }
  });

  /**
   * Create projectors
   */
  Object.keys(spec.events).forEach((e) => {
    const eventDef = spec.events[e];
    if (typeof eventDef === 'function') {
      res.projectors[e] = (state: S, event: any) => produce(state, (draft) => (eventDef as any)(draft, event));
    } else {
      Object.keys(eventDef as object).forEach((key) => {
        if (key === 'project') {
          res.projectors[e] = (state: S, event: any) => produce(state, (draft) => (eventDef as any)[key](draft, event));
        }
      });
    }
  });
  return res as AggregateDeclaration<S, C, E, Name>;
}
