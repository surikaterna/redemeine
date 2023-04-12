import { describe, expect, test } from '@jest/globals';
import { AggregateSpecification, CommandProcessors, createAggregate } from '../src/createAggregate';
import type { FunctionKeys, NonFunctionKeys, Unionize } from 'utility-types';

import { Command, Commands } from '../src/createCommand';
import { Draft } from 'immer';
import { NestedPairsOf } from '../src/utils/NestedPairOf';
import { AllKeys } from '../src/utils/AllKeys';
import { Merge } from '../src/utils/Merge';

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
        // interface TestState {
        //     age: Number;
        // }
        // const o: AggregateSpecification<TestState> = {
        //     name: 'test',
        //     initialState: { age: 12 },
        //     //   combo: ["cancel", "cancelled", () => {}],
        //     commands: {
        //         cancel: (state, event) => { },
        //         cancelPermanently: (state, event) => { }
        //     }
        // };







        // function tt<S, C extends Commands2<any>, E extends Events2<S, any>>(cmds: TDescriptor<S, C, E>): TDecorator<S, C, E> {
        //     const res = {};
        //     const cmd = cmds.commands || [];
        //     Object.keys(cmd).forEach((c) => (res[c] = (a: string) => cmd[c]));
        //     res['close'] = () => {
        //         return { payload: { remark: 'hello' } };
        //     };
        //     return res as TDecorator<S, C, E>;
        // }
        /*
                      command -> process-> events -> apply -> state
            */

        interface CounterState {
            value: number;
            cancelled: boolean;
        }

        const aggr = createAggregate({
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
                    cancel: (state) => { },
                    project: (state) => { }
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
        });


        type ttTest = {
            cancelled: {
                cancel: (state) => {};
                project: (state) => {};
            };
            closed: {
                close: (state) => {};
            };
        };

        // type t = ttTest;

        // type tt2 = Exclude<NestedPairsOf<t, Function>, { project: Function }>;

        // type tt3 = Merge<tt2>;

        //commands, processors, events, projectors
        //entities
        //middleware
        //mirage (read + write)

        // const res = tt(cc);
        // type ttType = typeof res;
        expect(aggr.close({ value: 12, cancelled: false }, 'hello').payload.remark).toEqual('hello');
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
