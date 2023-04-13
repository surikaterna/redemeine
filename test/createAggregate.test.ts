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
  test.only('event projectors from event def should update the state', () => {
    const aggr = createAggregate({
      type: 'counter',
      initialState: { value: 0 },
      events: {
        increasedBy: {
          project: (state, event) => {
            console.log('project', event.payload.with);
            state.value++; //= event.payload; //= e.payload ;
          },
          increase: (state, command: Command) => {
            return {
              type: 'a.b.event',
              payload: { with: 12 }
            };
          }
        }
      }
    });
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
