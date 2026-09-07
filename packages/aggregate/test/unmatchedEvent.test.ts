import { describe, expect, test, vi } from 'vitest';
import { createAggregate } from '@redemeine/aggregate';
import { Event } from '@redemeine/kernel';

interface TestState {
    count: number;
}

const initialState: TestState = { count: 0 };

describe('onUnmatchedEvent', () => {
    test('calls custom handler when event has no projector', () => {
        const handler = vi.fn();

        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .onUnmatchedEvent(handler)
            .build();

        const unknownEvent: Event = { type: 'counter.unknown.event', payload: {} };
        aggregate.apply(initialState, unknownEvent);

        expect(handler).toHaveBeenCalledWith('counter.unknown.event', 'Counter');
    });

    test('uses default console.warn when no handler provided', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .build();

        const unknownEvent: Event = { type: 'counter.unknown.event', payload: {} };
        aggregate.apply(initialState, unknownEvent);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('counter.unknown.event')
        );
        warnSpy.mockRestore();
    });

    test('does not call handler when event matches a projector', () => {
        const handler = vi.fn();

        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .onUnmatchedEvent(handler)
            .build();

        const validEvent: Event = { type: 'Counter.incremented.event', payload: { amount: 5 } };
        const newState = aggregate.apply(initialState, validEvent);

        expect(handler).not.toHaveBeenCalled();
        expect(newState.count).toBe(5);
    });
});
