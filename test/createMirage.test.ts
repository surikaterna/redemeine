import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createMirage, createLegacyAggregateBridge } from '../src/createMirage';
import { Event } from '../src/types';

interface TestState {
    value: number;
    title: string;
    line: { id: string, qty: number }[];
}

describe('Mirage tests', () => {
    const initialState: TestState = {
        value: 0,
        title: 'New',
        line: [{ id: '123', qty: 1 }]
    };

    const setupBuilder = () => {
        return createAggregate<TestState, 'test'>('test', initialState)
            .events({
                updated: (state: any, event: Event<number>) => {
                    state.value = event.payload;
                },
                lineUpdated: (state: any, event: Event<{lineId: string, id?: string, qty: number}>) => {
                    if (event.payload.id === 'abc') {
                        state.line.push({id: event.payload.id, qty: event.payload.qty});
                    } else if (event.payload.lineId === '123') {
                        const line = state.line.find((x: any) => x.id === '123');
                        if (line) line.qty = event.payload.qty;
                    }
                }
            })
            .commands((emit) => ({
                update: (state: any, value: number) => emit.updated(value),
                lineUpdate: (state: any, payload: {lineId: string, qty: number}) => emit.lineUpdated(payload)
            }))
            .build();
    };

    test('should initialize with initialState if no snapshot/events provided', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(0);
        expect(bridge.id).toBe('agg-1');
    });

    test('should load existing state from snapshot', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-2', {
            snapshot: { value: 10, title: 'Loaded', line: [] }
        });
        
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(10);
        expect(bridge._state.title).toBe('Loaded');
    });

    test('should load existing state from events', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-3', {
            events: [{ type: 'test.updated.event', payload: 42 }]
        });
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(42);
        expect(bridge._state.title).toBe('New');
    });

    test('should load existing state from snapshot and events', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-4', {
            snapshot: { value: 10, title: 'Loaded', line: [] },
            events: [{ type: 'test.updated.event', payload: 42 }]
        });
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(42);
        expect(bridge._state.title).toBe('Loaded');
    });

    test('should execute flat commands, update state & uncommitted', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        await live.update(42);

        expect(bridge._state.value).toBe(42);

        const uncommitted = bridge.getUncommittedEvents();
        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.updated.event');
        expect(uncommitted[0].payload).toBe(42);
    });

    test('should execute targeted commands via deep proxy recursively', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');

        await (live as any).line('123').update({ qty: 99 });

        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        const uncommitted = bridge.getUncommittedEvents();

        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.line.updated.event');
        expect(uncommitted[0].payload).toEqual({ qty: 99, lineId: '123', id: '123' });
    });

    test('should allow reading readable states directly from live object natively', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-r', {
            events: [{ type: 'test.updated.event', payload: 777 }]
        });

        expect(live.value).toBe(777); 

        // Native array functions shouldn't break proxy structure
        const firstLine = live.line[0];
        
        // Calling flat commands still behaves dynamically returning properly bounded Promise
        await live.update(888);
        expect(live.value).toBe(888);
    });

});
