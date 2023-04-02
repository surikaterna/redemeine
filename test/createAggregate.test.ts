import { describe, expect, test } from '@jest/globals';
import { AggregateDefinition, AggregateProjectors, createAggregate } from '../src/createAggregate';

interface OrderState {
  id: number;
  orderLines: { id: number }[];
}
const initialState: OrderState = {
  id: 0,
  orderLines: []
};

describe('createAggregate', () => {
  test('returns object', () => {
    const aggregate = createAggregate({
      name: 'order',
      initialState,
      events: {
        cancel: (state, cmd: { remark: string }) => {}
      }
    });
    expect(aggregate).not.toBeNull();
  });
  /*
        command -> process-> events -> apply -> state
    */

  interface AggDef<State = any> {
    name: string;
    initialState: State | (() => State);
    // combo: [string, string, Function];

    events: AggregateProjectors<State>;
  }

  test('called command', (done) => {
    interface TestState {
      age: Number;
    }
    const o: AggregateDefinition<TestState> = {
      name: 'test',
      initialState: { age: 12 },
      //   combo: ["cancel", "cancelled", () => {}],
      commands: {
        // cancel: (state, command, aggregate) => {
        //   return [
        //     aggregate.events.canceled(),
        //     aggregate.events.permanentlyCanceled(),
        //   ];
        // },
      },
      events: {
        canceled: (state, event) => {},
        permanentlyCanceled: (state, event) => {}
      }
    };

    createAggregate(o).events.canceled({ age: 12 }, null);

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
