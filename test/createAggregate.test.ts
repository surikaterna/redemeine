import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { Command } from '../src/createCommand';
import { Event } from '../src/createEvent';

describe('createAggregate', () => {
  //   test('create event projectors from event def', () => {
  //     const aggr = createAggregate({
  //       type: 'counter',
  //       initialState: undefined,
  //       events: {
  //         closed: {
  //           close: (state) => {
  //             return { type: 'a.b.event', payload: 2 };
  //           },
  //           project: (state, event) => {}
  //         }
  //         // cancelled: {
  //         //   cancel: (state) => {},
  //         //   project: (state) => {}
  //         // }
  //       }
  //     });
  //     expect(Object.keys(aggr.projectors)).toHaveLength(2);
  //   });
  interface CounterState {
    value: number;
  }
  test.only('event projectors from event def should update the state', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0 },
      events: {
        increasedBy: {
          project: (state, event: Event<{ with: number }>) => {
            console.log('project', event.type);
            state.value += 1;
            return 'test';
          },
          increaseBy: (stateXX, command: Command<number>) => {
            return {
              type: 'counter.increasedBy.event',
              payload: { with: command.payload }
            } as Event<{with:number}>;
          }
        },
        increased: {
          project: (state, event) => {
            console.log('project', event.type);
            state.value += 1;
            return 'test';
          },
          increase: (stateXX, command: Command<void>) => {
            return {
              type: 'counter.increased.event',
              payload: undefined
            } as Event;
          }
        }        
      }
    });
    aggr.commands.increaseBy({ value: 12 }, { type: 'counter.increaseBy.command', payload: 12 });
    aggr.projectors.increasedBy({ value: 12 }, { type: 'counter.increasedBy.event', payload: { with: 12 } });
    aggr.commands.increase({value:1},{ type: 'counter.increase.command', payload:  12 } })
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
