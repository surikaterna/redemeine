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
  [commandName: string]: any;
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

type EventCommandFunction<S, P, RootEvent, Emit, Invoke> = (
  state: ReadonlyDeep<S>,
  command: P,
  emit: Emit extends AnyEventCreators ? Emit : AnyEventCreators,
  invoke: Invoke extends AnyInvokeCreators ? Invoke : AnyInvokeCreators
) => RootEvent | Event | Event[];

type ValidateEventSpecification<S, ES extends Events<S, any>, Name extends string, InvokeObj> = ES & {
  [T in keyof ES]: ES[T] extends {
    project(state3: Draft<S>, event: infer E extends Event): void;
  }
    ? {
        [K in Exclude<keyof ES[T], 'project'>]: EventCommandFunction<
          S,
          ES[T][K] extends (s: any, p: infer P, ...args: any[]) => any ? P : any,
          E,
          EventCreators<Name, ES>,
          InvokeObj
        >;
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

export type AnyEventCreators = Record<string, (payload?: any) => Event<any, any>>;
export type AnyInvokeCreators = Record<string, (payload?: any) => Event<any, any> | Event<any, any>[]>;

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
  const cmd = spec.commands || ({} as Record<string, any>);

  const emitObject: any = {};
  Object.keys(spec.events).forEach((e) => {
    emitObject[e] = (payload: any) => ({
      type: `${spec.type}.${e}.event`,
      payload: payload === undefined ? undefined : payload
    });
  });

  const executeCommandWithContext = (initialState: any, rootFn: Function, rootPayload: any) => {
    let currentState = initialState;

    const stateProxy = new Proxy({}, {
      get(target, prop) { return (currentState as any)[prop]; },
      has(target, prop) { return prop in (currentState as any); },
      ownKeys(target) { return Reflect.ownKeys(currentState as any); },
      getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(currentState as any, prop); },
      set() { throw new Error("State is readonly in commands. Mutate state in projectors."); }
    });

    const invokeObject: Record<string, any> = {};

    const createInvoke = (cmdFunc: Function) => {
      return (payload: any) => {
        const evsOrEv = cmdFunc(stateProxy, payload, emitObject, invokeObject);
        const emitted = Array.isArray(evsOrEv) ? evsOrEv : (evsOrEv ? [evsOrEv] : []);
        
        emitted.forEach((ev: any) => {
          const parts = (ev.type as string).split('.');
          if (parts.length >= 2) {
            const projectorKey = parts[1];
            if (res.projectors[projectorKey]) {
              currentState = res.projectors[projectorKey](currentState, ev);
            }
          }
        });
        return evsOrEv;
      };
    };

    Object.keys(cmd).forEach((c) => {
      invokeObject[c] = createInvoke(cmd[c]);
    });
    Object.keys(spec.events).forEach((e) => {
      const eventDef = spec.events[e];
      if (typeof eventDef !== 'function') {
        Object.keys(eventDef as object).forEach((commandKey) => {
          if (commandKey !== 'project') {
            invokeObject[commandKey] = createInvoke((eventDef as any)[commandKey]);
          }
        });
      }
    });

    return rootFn(stateProxy, rootPayload, emitObject, invokeObject);
  };

  /**
   * Create commands
   */
  Object.keys(cmd).forEach((c) => {
    res.commands[c] = (state: any, payload: any) => executeCommandWithContext(state, cmd[c], payload);
  });
  Object.keys(spec.events).forEach((e) => {
    const eventDef = spec.events[e];
    if (typeof eventDef !== 'function') {
      Object.keys(eventDef as object).forEach((commandKey) => {
        if (commandKey !== 'project') {
          res.commands[commandKey] = (state: any, payload: any) =>
            executeCommandWithContext(state, (eventDef as any)[commandKey], payload);
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
