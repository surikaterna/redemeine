import { createAggregate } from '@redemeine/aggregate';
import { createMirage } from '../src/createMirage';
import { Event } from '@redemeine/kernel';

interface TestState {
    value: number;
    name: string;
}

const setupMirage = () => {
    const builder = createAggregate<TestState, 'test'>('test', { value: 42, name: 'hello' })
        .events({
            updated: (state: any, event: Event<number>) => {
                state.value = event.payload;
            }
        })
        .commands((emit) => ({
            update: (state: any, v: number) => emit.updated(v)
        }))
        .build();

    return createMirage(builder, 'proxy-1');
};

describe('Proxy edge cases', () => {
    test('symbol property access does not crash', () => {
        const live = setupMirage();
        const sym = Symbol('test');
        expect((live as any)[sym]).toBeUndefined();
    });

    test('__proto__ access returns undefined', () => {
        const live = setupMirage();
        // __proto__ is a dangerous property; proxy should guard it
        expect((live as any).__proto__).toBeUndefined();
    });

    test('constructor access returns undefined', () => {
        const live = setupMirage();
        expect((live as any).constructor).toBeUndefined();
    });

    test('accessing non-existent property returns a callable (command proxy fallback)', () => {
        const live = setupMirage();
        // Non-existent props return a function due to command proxy behavior
        expect(typeof (live as any).doesNotExist).toBe('function');
    });

    test('accessing valid state properties works', () => {
        const live = setupMirage();
        expect(live.value).toBe(42);
        expect(live.name).toBe('hello');
    });

    test('direct mutation is blocked', () => {
        const live = setupMirage();
        expect(() => {
            (live as any).value = 999;
        }).toThrow();
    });
});
