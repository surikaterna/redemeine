import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';

interface OrderState {
    id: number,
    orderLines: { id: number }[]
};
const initialState: OrderState = {
    id: 0,
    orderLines: []
}

describe('createAggregate', () => {
    test('returns object', () => {

        const aggregate = createAggregate({
            name: 'order',
            initialState: initialState,
            applyers: {
                cancel: (state, cmd: { remark: string }) => {

                }
            }
        });
        expect(aggregate).not.toBeNull();
    });
    /*
        command -> process-> events -> apply -> state
    */

    test('called command', (done) => {
        const o = {
            combo: ['cancel', 'cancelled', ()=> {

            }],
            commands: {
                cancel: (state, command) => { }
            },
            events: {
                canceled: (state, event) => { }
            }
        }
        //createCommand('order.cancel', ()=>{});

        const aggregate = createAggregate({
            name: 'order',
            initialState: initialState,
            applyers: {
                cancel: (state, cmd: { remark: string }) => {
                    done();
                }
            }
        });
        expect(aggregate.cancel).not.toBeNull();
        aggregate.cancel();
    });
});