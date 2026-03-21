import { describe, expect, test } from '@jest/globals';
import { createCommand } from '../src/createCommand';

describe('createCommand', () => {
  test('returns function', () => {
    const cmd = createCommand<string>('order.cancel.command');
    expect(typeof cmd == 'function').toBeTruthy();
  });
  test('returns string payload', () => {
    const cmd = createCommand<string>('order.cancel.command');
    expect(cmd('yep').payload).toBe('yep');
  });
  test('returns number payload', () => {
    const cmd = createCommand<number>('order.cancel.command');
    expect(cmd(12).payload).toBe(12);
  });
  test('returns complex payload', () => {
    const cmd = createCommand<{ remark: string; list: string[] }>('order.comment.command');
    const payload = { remark: 'hello', list: ['1', 'other'] };
    expect(cmd(payload).payload).toBe(payload);
    expect(cmd(payload).type).toBe('order.comment.command');
  });
  test('returns prepared payload', () => {
    const cmd = createCommand('order.hello.command', (text: string, user: string, age: number) => {
      return {
        headers: { dummy: true },
        payload: {
          text,
          user,
          age
        }
      };
    });
    expect(cmd('hello', 'world', 12).payload).toEqual({ text: 'hello', user: 'world', age: 12 });
  });
});
