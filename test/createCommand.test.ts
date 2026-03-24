import { afterEach, describe, expect, test } from '@jest/globals';
import { createCommand } from '../src/createCommand';
import { resetIdentityFactory, setIdentityFactory } from '../src/identity';

describe('createCommand', () => {
    afterEach(() => {
        resetIdentityFactory();
    });

    test('should create command with generated id by default', () => {
        const cmdFactory = createCommand<number>('order.cancel.command');
        const cmd = cmdFactory(123);

        expect(cmd.id).toEqual(expect.any(String));
        expect(cmd.type).toBe('order.cancel.command');
        expect(cmd.payload).toBe(123);
    });

    test('should create a command factory without a prepare function', () => {
        const cmdFactory = createCommand<number>('order.cancel.command');
        const cmd = cmdFactory(123);
        
        expect(cmd).toEqual({ id: expect.any(String), type: 'order.cancel.command', payload: 123 });
        expect(cmdFactory.type).toBe('order.cancel.command');
        expect(cmdFactory.toString()).toBe('order.cancel.command');
    });

    test('should create a command factory with a prepare function taking multiple args', () => {
        const cmdFactory = createCommand('order.update.command', (id: string, value: number) => ({
            payload: { id, value }
        }));
        
        const cmd = cmdFactory('a1', 42);
        expect(cmd).toEqual({
            id: expect.any(String),
            type: 'order.update.command', 
            payload: { id: 'a1', value: 42 } 
        });
    });

    test('should use custom IdentityFactory when provided', () => {
        setIdentityFactory(() => 'cmd-fixed-id');
        const cmdFactory = createCommand<number>('order.cancel.command');
        const cmd = cmdFactory(55);

        expect(cmd.id).toBe('cmd-fixed-id');
    });

    test('should throw an error if prepare function returns falsy', () => {
        const cmdFactory = createCommand('bad.command', () => null as any);
        expect(() => cmdFactory()).toThrow('prepareCommand did not return an object with a payload');
    });
});
