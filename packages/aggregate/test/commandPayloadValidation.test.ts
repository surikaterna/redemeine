import { describe, expect, test, afterEach } from '@jest/globals';
import { createCommandProcessor } from '../src/createCommandProcessor';
import { Contract, ContractError, resetIdentityFactory } from '@redemeine/kernel';
import { z } from 'zod';

describe('command payload validation with Contract', () => {
    afterEach(() => {
        resetIdentityFactory();
    });

    test('throws ContractError when payload fails schema validation', () => {
        const contract = new Contract();
        contract.addCommand('myAggregate.do_something.command', z.object({
            name: z.string(),
            age: z.number()
        }));

        const mockMap = {
            doSomething: (state: any, payload: any) => {
                return { type: 'something.done.event', payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {},
            undefined,
            contract
        );

        expect(() => {
            processor({ val: 10 }, { type: 'myAggregate.do_something.command', payload: { name: 123, age: 'wrong' } });
        }).toThrow(ContractError);
    });

    test('passes through when payload matches schema', () => {
        const contract = new Contract();
        contract.addCommand('myAggregate.do_something.command', z.object({
            name: z.string(),
            age: z.number()
        }));

        const mockMap = {
            doSomething: (state: any, payload: any) => {
                return { type: 'something.done.event', payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {},
            undefined,
            contract
        );

        const result = processor({ val: 10 }, {
            type: 'myAggregate.do_something.command',
            payload: { name: 'Alice', age: 30 }
        });

        expect(result[0].type).toBe('something.done.event');
        expect(result[0].payload).toEqual({ name: 'Alice', age: 30 });
    });

    test('skips validation when no schema exists for command type', () => {
        const contract = new Contract();
        // No schema added for this command

        const mockMap = {
            doSomething: (state: any, payload: any) => {
                return { type: 'something.done.event', payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {},
            undefined,
            contract
        );

        const result = processor({ val: 10 }, {
            type: 'myAggregate.do_something.command',
            payload: { anything: 'goes' }
        });

        expect(result[0].type).toBe('something.done.event');
    });

    test('skips validation when no contract provided', () => {
        const mockMap = {
            doSomething: (state: any, payload: any) => {
                return { type: 'something.done.event', payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {}
        );

        const result = processor({ val: 10 }, {
            type: 'myAggregate.do_something.command',
            payload: { anything: 'goes' }
        });

        expect(result[0].type).toBe('something.done.event');
    });

    test('error message includes command type and validation details', () => {
        const contract = new Contract();
        contract.addCommand('myAggregate.do_something.command', z.object({
            name: z.string()
        }));

        const mockMap = {
            doSomething: (state: any, payload: any) => {
                return { type: 'something.done.event', payload };
            }
        };

        const processor = createCommandProcessor<{ val: number }>(
            'myAggregate',
            mockMap,
            {},
            undefined,
            contract
        );

        expect(() => {
            processor({ val: 10 }, {
                type: 'myAggregate.do_something.command',
                payload: { name: 42 }
            });
        }).toThrow(/Command "myAggregate\.do_something\.command" payload failed validation/);
    });
});
