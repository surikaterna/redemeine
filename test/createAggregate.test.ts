import { describe, expect, test } from '@jest/globals';
import { AggregateDefinition, CommandProcessors, createAggregate } from '../src/createAggregate';
import type { FunctionKeys, NonFunctionKeys } from 'utility-types';

import { Command, Commands } from '../src/createCommand';
import { Draft } from 'immer';

// interface OrderState {
//   id: number;
//   orderLines: { id: number }[];
// }
// const initialState: OrderState = {
//   id: 0,
//   orderLines: []
// };

describe('createAggregate', () => {
  // test('returns object', () => {
  //   const aggregate = createAggregate({
  //     name: 'order',
  //     initialState,
  //     events: {
  //       cancel: (state, cmd: { remark: string }) => {}
  //     }
  //   });
  //   expect(aggregate).not.toBeNull();
  // });
  // /*
  //       command -> process-> events -> apply -> state
  //   */

  // interface AggDef<State = any> {
  //   name: string;
  //   initialState: State | (() => State);
  //   // combo: [string, string, Function];

  //   events: AggregateProjectors<State>;
  // }

  test('called command', () => {
    interface TestState {
      age: Number;
    }
    const o: AggregateDefinition<TestState> = {
      name: 'test',
      initialState: { age: 12 },
      //   combo: ["cancel", "cancelled", () => {}],
      commands: {
        cancel: (state, event) => {},
        cancelPermanently: (state, event) => {}
      }
    };

    interface Command2<S = any, P extends any = any> {
      type: string;
      payload: P;
    }

    type Commands2<T extends keyof any = string, P extends any = any> = Record<T, () => Command2<any, P>>;

    let cmds = {
      test: () => {
        return {
          type: 'test',
          payload: {}
        };
      },
      test2: () => {
        return {
          type: 'test2',
          payload: {}
        };
      }
    };

    type ExtractType<TT extends Commands2> = {
      [K in keyof TT]: TT[K];
    };

    // Events

    type EventWithCommand<S, P> = {
      [K: string]: (state: S, ...any: never[]) => void;
    };

    type EventOrEventCommand<S, P extends any = any> = EventWithCommand<S, P> | (() => void);

    type Events2<S, T extends keyof any = string, P extends any = any> = Record<T, EventOrEventCommand<S, P>>;

    type TDescriptor<S, C extends Commands2<any> = Commands2<any>, E extends Events2<S, any> = Events2<S, any>, Name extends string = string> = {
      type: Name;
      initialState: S;
      commands?: C;
      events: E;
    };

    type ReplaceFirstArg<S, F> = F extends (x: any, ...args: infer P) => infer R ? (state: S, ...args: P) => R : never;

    type TDecorator<S, C extends Record<string, (...args: any) => any>, E extends Events2<S, any> = Events2<S, any>> = {
      // [K in keyof C]: (a: string) => ReturnType<C[K]>;
    } & {
      // extract commands from event definitions
      [K in Exclude<NestedKeysOf<E, Function>, 'project'>]: (state: Readonly<S>) => void;
    };

    function tt<S, C extends Commands2<any>, E extends Events2<S, any>>(cmds: TDescriptor<S, C, E>): TDecorator<S, C, E> {
      const res = {};
      const cmd = cmds.commands || [];
      Object.keys(cmd).forEach((c) => (res[c] = (a: string) => cmd[c]));
      res['close'] = () => {
        return { payload: { remark: 'hello' } };
      };
      return res as TDecorator<S, C, E>;
    }
    /*
                  command -> process-> events -> apply -> state
        */

    interface CounterState {
      value: number;
      cancelled: boolean;
    }

    let cc = {
      type: 'counter',
      initialState: {
        value: 0,
        cancelled: false
      } as CounterState,
      // commands: {
      //   cancel: (state, command) => {
      //     return [];
      //   }
      // },
      events: {
        cancelled: {
          cancel: (state) => {},
          project: (state) => {}
        },
        /** this is closing */
        closed: {
          /**
           * closes the state
           * @param state my state
           * @param remark my param
           * @returns an event
           */
          close: (state, remark: string, remark2?: string) => {
            if (state.cancelled) {
              throw new Error('Already closed');
            }
            return { payload: { remark } };
          },
          project: (state) => {
            state.cancelled = true;
          }
        }
      }
    };

    type NestedKeysOf<T, S> = T extends S
      ? never
      : {
          [K in keyof T]: T[K] extends S ? K : NestedKeysOf<T[K], S>;
        }[keyof T & string];

    type ttTest = {
      cancelled: {
        cancel: (state) => {};
        project: (state) => {};
      };
      closed: {
        close: (state) => {};
      };
    };

    type ExtractedEventCommands<E extends object, S> = {
      // extract commands from event definitions
      [K in NestedKeysOf<E, Function>]: void;
    };

    type tt = ExtractedEventCommands<ttTest, {}>;
    type t = ttTest;
    type tt2 = Exclude<NestedKeysOf<t, Function>, 'project'>;
    //commands, processors, events, projectors
    //entities
    //middleware
    //mirage (read + write)

    const res = tt(cc);
    type ttType = typeof res;
    expect(res.close({ value: 12, cancelled: false }, 'hello').payload.remark).toEqual('hello');
    /*    let cp: CommandProcessors<TestState, { test: (state: TestState, cmd: any) => Record<T, Command<{}>> }> = {
          test: (state: TestState, cmd: any) => {
            return {
              type: 'test',
              payload: cmd
            };
          }
        };
        */
    //cp.test({ age: 12 }, { type: 'test', payload: {} });
    // cp.test({ age: 12 }, );

    //createAggregate(o).commands.cancelled2({ age: 12 }, null);

    //createCommand('order.cancel', ()=>{});

    // const aggregate = createAggregate({
    //   name: "order",
    //   initialState: initialState,
    //   events: {
    //     cancel: (state, cmd: { remark: string }) => {
    //       done();
    //     },
    //   },
    // });
    // expect(aggregate.cancel).not.toBeNull();
    // aggregate.cancel();
  });
});
