import { describe, expect, test } from '@jest/globals';
import { createCommandProcessor } from '../src/createCommandProcessor';
import { Command } from '../src/types';

describe('createCommandProcessor', () => {
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

        const result = processor({ val: 10 }, { type: 'myAggregate.doSomething.command', payload: 5 } as Command);
        
        expect(Array.isArray(result)).toBe(true);
        expect(result[0]).toEqual({ type: 'something.done.event', payload: 15 });
    });

    test('should throw error on unknown commands', () => {
        const processor = createCommandProcessor('myAggregate', {}, {});
        expect(() => {
            processor({}, { type: 'myAggregate.unknown.command', payload: null });
        }).toThrow('Unknown command: myAggregate.unknown.command');
    });
});
