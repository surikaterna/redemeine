import { afterEach, describe, expect, test } from '@jest/globals';
import { createCommandProcessor } from '../src/createCommandProcessor';
import { Command, resetIdentityFactory, setIdentityFactory } from '@redemeine/kernel';

describe('createCommandProcessor', () => {
    afterEach(() => {
        resetIdentityFactory();
    });

    test('should match and routing string commands to map implementations', () => {
        const mockMap = {
            doSomething: (state: any, payload: number) => {
                return { type: 'something.done.event', payload: state.val + payload };
            }
        };

        const processor = createCommandProcessor<{val: number}>(
            'myAggregate',
            mockMap,
            {}
        );

        const result = processor({ val: 10 }, { type: 'myAggregate.do_something.command', payload: 5 } as Command);
        
        expect(Array.isArray(result)).toBe(true);
        expect(result[0].id).toEqual(expect.any(String));
        expect(result[0].type).toBe('something.done.event');
        expect(result[0].payload).toBe(15);
        expect(result[0].metadata.command.type).toBe('myAggregate.do_something.command');
        expect(result[0].metadata.command.id).toEqual(expect.any(String));
        expect(result[0].metadata.command.summary).toBeUndefined();
    });

    test('should link one command to many emitted events', () => {
        const mockMap = {
            doMany: (state: any, payload: number) => {
                return [
                    { type: 'something.one.event', payload: state.val + payload },
                    { type: 'something.two.event', payload: state.val - payload, metadata: { source: 'handler' } }
                ];
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {}
        );

        const command = {
            type: 'myAggregate.do_many.command',
            payload: 5,
            metadata: { requestId: 'req-1' }
        } as Command;

        const result = processor({ val: 10 }, command);

        expect(result).toHaveLength(2);
        expect(result[0].id).toEqual(expect.any(String));
        expect(result[0].metadata).toEqual({
            command: {
                id: expect.any(String),
                type: 'myAggregate.do_many.command'
            }
        });
        expect(result[1].id).toEqual(expect.any(String));
        expect(result[1].metadata).toEqual({
            source: 'handler',
            command: {
                id: expect.any(String),
                type: 'myAggregate.do_many.command'
            }
        });
    });

    test('should include command summary and storeRef from command headers when provided', () => {
        const mockMap = {
            doSomething: (state: any, payload: number) => ({ type: 'something.done.event', payload: state.val + payload })
        };
        const processor = createCommandProcessor<{ val: number }>('myAggregate', mockMap, {});

        const result = processor(
            { val: 10 },
            {
                id: 'cmd-1',
                type: 'myAggregate.do_something.command',
                payload: 5,
                headers: {
                    commandSummary: { important: true, operation: 'doSomething' },
                    commandStoreRef: 'commands://master/cmd-1'
                }
            } as Command
        );

        expect(result[0].metadata.command).toEqual({
            id: 'cmd-1',
            type: 'myAggregate.do_something.command',
            summary: { important: true, operation: 'doSomething' },
            storeRef: 'commands://master/cmd-1'
        });
    });

    test('should preserve provided command and event ids', () => {
        const mockMap = {
            doSomething: (state: any, payload: number) => {
                return { id: 'existing-event-id', type: 'something.done.event', payload: state.val + payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>('myAggregate', mockMap, {});
        const result = processor(
            { val: 10 },
            { id: 'existing-command-id', type: 'myAggregate.do_something.command', payload: 5 } as Command
        );

        expect(result[0].id).toBe('existing-event-id');
        expect(result[0].metadata.command.id).toBe('existing-command-id');
    });

    test('should use custom IdentityFactory for generated ids in processor', () => {
        setIdentityFactory(() => 'processor-fixed-id');
        const mockMap = {
            doSomething: (state: any, payload: number) => ({ type: 'something.done.event', payload: state.val + payload })
        };
        const processor = createCommandProcessor<{ val: number }>('myAggregate', mockMap, {});

        const result = processor({ val: 10 }, { type: 'myAggregate.do_something.command', payload: 5 } as Command);

        expect(result[0].id).toBe('processor-fixed-id');
        expect(result[0].metadata.command.id).toBe('processor-fixed-id');
    });

    test('should throw error on unknown commands', () => {
        const processor = createCommandProcessor('myAggregate', {}, {});
        expect(() => {
            processor({}, { type: 'myAggregate.unknown.command', payload: null });
        }).toThrow('Unknown command: myAggregate.unknown.command');
    });
});
