import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createMirage, createLegacyAggregateBridge } from '../src/createMirage';
import { EventStore, createDepot } from '../src/Depot';
import { Event } from '../src/types';

class MockEventStore implements EventStore {
    public events = new Map<string, Event<any, any>[]>();

    async getEvents(id: string): Promise<Event<any, any>[]> {
        return this.events.get(id) || [];
    }

    async saveEvents(id: string, events: Event<any, any>[], expectedVersion?: number): Promise<void> {
        const existing = this.events.get(id) || [];
        this.events.set(id, [...existing, ...events]);
    }

    _setMockEvents(id: string, events: Event<any, any>[]) {
        this.events.set(id, events);
    }
}

interface TestState {
    value: number;
    title: string;
    line: { id: string, qty: number }[];
}

describe('Mirage Depot tests', () => {
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
                    }
                }
            })
            .commands((emit) => ({
                update: (state: any, value: number) => emit.updated(value),
                lineUpdate: (state: any, payload: {lineId: string, qty: number}) => emit.lineUpdated(payload)
            }))
            .build();
    };

    test('should initialize with initialState if not found in depot', async () => {
        const builder = setupBuilder();
        const store = new MockEventStore();
        const liveDepot = createDepot(builder, store as any);

        const live = await liveDepot.get('agg-1');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(0);
        expect(bridge.id).toBe('agg-1');
    });

    test('should load existing state from depot', async () => {
        const builder = setupBuilder();
        const store = new MockEventStore();
        store._setMockEvents('agg-2', [{ type: 'test.updated.event', payload: 10 }]);

        const liveDepot = createDepot(builder, store as any);
        const live = await liveDepot.get('agg-2');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);

        expect(bridge._state.value).toBe(10);
        expect(bridge._state.title).toBe('New'); // not Loaded since it's events!
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

        await (live as any).line['123'].update({ qty: 99 });

        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        const uncommitted = bridge.getUncommittedEvents();

        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.line.updated.event');
        expect(uncommitted[0].payload).toEqual({ qty: 99, lineId: '123', id: '123' });
    });

    test('save() persists state and clears uncommitted', async () => {
        const builder = setupBuilder();
        const store = new MockEventStore();
        let saveCalled = false;
        store.saveEvents = async (id, evs) => {
            saveCalled = true;
        };
        const liveDepot = createDepot(builder, store as any);
        const live = await liveDepot.get('agg-1'); 

        await live.update(55);

        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        expect(bridge.getUncommittedEvents().length).toBe(1);

        await liveDepot.save(live);

        expect(saveCalled).toBe(true);
        expect(bridge.getUncommittedEvents().length).toBe(0);
    });

    test('should allow reading readable states directly from live object natively', async () => {
        const builder = setupBuilder();
        const store = new MockEventStore();
        store._setMockEvents('agg-r', [{ type: 'test.updated.event', payload: 777 }]);

        const liveDepot = createDepot(builder, store as any);
        const live = await liveDepot.get('agg-r');

        expect(live.state.value).toBe(777);

        // Native array functions shouldn't break proxy structure
        const firstLine = live.state.line[1] || live.state.line[0]; // depends on push order
        
        // Calling flat commands still behaves dynamically returning properly bounded Promise
        await live.update(888);
        expect(live.state.value).toBe(888);
    });

});
