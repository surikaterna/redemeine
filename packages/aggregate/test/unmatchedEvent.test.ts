import { describe, expect, test, jest } from '@jest/globals';
import { createAggregate } from '@redemeine/aggregate';
import { Event } from '@redemeine/kernel';

interface TestState {
    count: number;
}

const initialState: TestState = { count: 0 };

describe('onUnmatchedEvent', () => {
    test('calls custom handler when event has no projector', () => {
        const handler = jest.fn();

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
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
        const handler = jest.fn();

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

    test('custom handler that throws propagates the error', () => {
        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .onUnmatchedEvent((eventType, aggregateName) => {
                throw new Error(`Unhandled: ${eventType} on ${aggregateName}`);
            })
            .build();

        expect(() => aggregate.apply(initialState, { type: 'counter.bogus.event', payload: {} }))
            .toThrow('Unhandled: counter.bogus.event on Counter');
    });

    test('custom handler that returns void continues normally', () => {
        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .onUnmatchedEvent(() => { /* silently ignore */ })
            .build();

        // Should not throw and state should remain unchanged
        const result = aggregate.apply(initialState, { type: 'counter.bogus.event', payload: {} });
        expect(result.count).toBe(0);
    });

    test('multiple unmatched events in sequence all trigger handler', () => {
        const handler = jest.fn();

        const aggregate = createAggregate('Counter', initialState)
            .events({
                incremented: (state, event: Event<{ amount: number }>) => {
                    state.count += event.payload.amount;
                }
            })
            .onUnmatchedEvent(handler)
            .build();

        aggregate.apply(initialState, { type: 'counter.a.event', payload: {} });
        aggregate.apply(initialState, { type: 'counter.b.event', payload: {} });
        aggregate.apply(initialState, { type: 'counter.c.event', payload: {} });

        expect(handler).toHaveBeenCalledTimes(3);
        expect(handler).toHaveBeenCalledWith('counter.a.event', 'Counter');
        expect(handler).toHaveBeenCalledWith('counter.b.event', 'Counter');
        expect(handler).toHaveBeenCalledWith('counter.c.event', 'Counter');
    });
});
