import { describe, expect, test } from '@jest/globals';
import { createCommand } from '../src/createCommand';

describe('createCommand', () => {
    test('should create a command factory without a prepare function', () => {
        const cmdFactory = createCommand<number>('order.cancel.command');
        const cmd = cmdFactory(123);
        
        expect(cmd).toEqual({ type: 'order.cancel.command', payload: 123 });
        expect(cmdFactory.type).toBe('order.cancel.command');
        expect(cmdFactory.toString()).toBe('order.cancel.command');
    });

    test('should create a command factory with a prepare function taking multiple args', () => {
        const cmdFactory = createCommand('order.update.command', (id: string, value: number) => ({
            payload: { id, value }
        }));
        
        const cmd = cmdFactory('a1', 42);
        expect(cmd).toEqual({ 
            type: 'order.update.command', 
            payload: { id: 'a1', value: 42 } 
        });
    });

    test('should throw an error if prepare function returns falsy', () => {
        const cmdFactory = createCommand('bad.command', () => null as any);
        expect(() => cmdFactory()).toThrow('prepareCommand did not return an object with a payload');
    });
});
