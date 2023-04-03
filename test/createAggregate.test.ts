import { describe, expect, test } from '@jest/globals';
import { AggregateDefinition, CommandProcessors, createAggregate } from '../src/createAggregate';
import { Command, Commands } from '../src/createCommand';

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

    type TDescriptor<C extends Commands2<any>> = {
      commands: C;
      events?: null;
    };

    type TDecorator<TT extends Record<string, (...args: any) => any>> = {
      [K in keyof TT]: (string) => ReturnType<TT[K]>;
    };

    function tt<TT extends Commands2<any>>(cmds: TDescriptor<TT>): TDecorator<TT> {
      const res = {};
      Object.keys(cmds.commands).forEach((c) => (res[c] = (a: string) => cmds.commands[c]));
      return res as TDecorator<TT>;
    }
    tt({
      commands: {
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
        },
        ttt: () => {
          return {
            type: 'ttt',
            payload: {}
          };
        }
      }
    }).test2('heelo');

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
