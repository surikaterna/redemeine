import { describe, expect, test } from '@jest/globals';
import { createCommand } from '../src/createCommand';

describe('createCommand', () => {
    test('returns function', () => {
        const cmd = createCommand<string>('order.cancel');
        expect(typeof cmd == 'function').toBeTruthy()
    });
    test('returns string payload', () => {
        const cmd = createCommand<string>('order.cancel');
        expect(cmd('yep').payload).toBe('yep');
    });
    test('returns number payload', () => {
        const cmd = createCommand<number>('order.cancel');
        expect(cmd(12).payload).toBe(12);
    });
    test('returns complex payload', () => {
        const cmd = createCommand<{ remark: string, list: string[] }>('order.comment');
        const payload = { remark: 'hello', list: ['1', 'other'] };
        expect(cmd(payload).payload).toBe(payload);
    });
});