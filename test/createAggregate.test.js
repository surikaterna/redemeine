"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const createAggregate_1 = require("../src/createAggregate");
(0, globals_1.describe)('createAggregate', () => {
    globals_1.test.only('event projectors from event def should update the state', () => {
        const aggr = (0, createAggregate_1.createAggregate)({
            type: 'counter',
            initialState: { value: 0 },
            events: {
                increasedBy: {
                    project: (state, event) => {
                        console.log('project', event.type);
                        state.value += 1;
                    },
                    increaseBy: (stateXX, command) => {
                        return {
                            type: 'counter.increasedBy.event',
                            payload: { with: command.payload }
                        };
                    }
                },
                increased: {
                    project: (state, event) => {
                        console.log('project', event.type);
                        state.value += 1;
                    },
                    increase: (stateXX, command) => {
                        return {
                            type: 'counter.increased.event',
                            payload: undefined
                        };
                    }
                }
            }
        });
        const mockState = { value: 12 };
        // Command generation logic tested
        const cmdResult = aggr.commands.increaseBy(mockState, { type: 'counter.increaseBy.command', payload: 12 });
        // Test that Immer successfully mutates a draft and maintains immutability of original
        const newState = aggr.projectors.increasedBy(mockState, { type: 'counter.increasedBy.event', payload: { with: 12 } });
        (0, globals_1.expect)(newState.value).toBe(13); // New state is updated
        (0, globals_1.expect)(mockState.value).toBe(12); // Original state remains untouched
        aggr.commands.increase({ value: 1 }, { type: 'counter.increase.command', payload: undefined });
        // aggr.projectors.increasedBy(
        //   { value: 0 },
        //   {
        //     type: 'a.b.event',
        //     payload: 12
        //   }
        // );
        // aggr.projectors.increasedBy(
        //   { value: 0 },
        //   {
        //     type: 'a.b.event',
        //     payload: 12
        //   }
        // );
        // expect(aggr.projectors.increased({ type: 'counter.increased.event', payload: { remark: 'oh no' } })).toHaveLength(2);
    });
    //   test('create commands structure from event def', () => {
    //     const aggr = createAggregate({
    //       type: 'counter',
    //       initialState: undefined,
    //       events: {
    //         closed: {
    //           close: undefined,
    //           project: (state) => {}
    //         },
    //         cancelled: {
    //           cancel: undefined,
    //           project: (state) => {}
    //         }
    //       }
    //     });
    //     expect(Object.keys(aggr.commands)).toHaveLength(2);
    //   });
    //   test('command is callable from events spec', () => {
    //     interface CounterState {
    //       value: number;
    //       cancelled: boolean;
    //     }
    //     const aggr = createAggregate({
    //       type: 'counter',
    //       initialState: {
    //         value: 0,
    //         cancelled: false
    //       } as CounterState,
    //       events: {
    //         cancelled: {
    //           cancel: (state) => {},
    //           project: (state) => {}
    //         },
    //         /** this is closing */
    //         closed: {
    //           /**
    //            * closes the state
    //            * @param state my state
    //            * @param remark my param
    //            * @returns an event
    //            */
    //           close: (state, remark: string, remark2?: string) => {
    //             if (state.cancelled) {
    //               throw new Error('Already closed');
    //             }
    //             return { payload: { remark: remark + remark2 } };
    //           },
    //           project: (state) => {
    //             state.cancelled = true;
    //           }
    //         }
    //       }
    //     });
    //     console.log(Object.keys(aggr.commands));
    //     expect(aggr.commands.close({ value: 12, cancelled: false }, 'hello', 'world').payload.remark).toEqual('helloworld');
    //   });
});
