import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createMirage, createLegacyAggregateBridge, MirageDepot } from '../src/createMirage';
import { Depot } from '../src/Depot';
import { Event } from '../src/types';

class MockDepot<S> implements Depot<string, S> {
    private store = new Map<string, S>();

    async findOne(id: string): Promise<S> {
        return this.store.get(id) as S;
    }

    find(): any {
        return [];
    }

    async save(aggregate: S): Promise<S> {
        return aggregate;
    }

    _setMockState(id: string, state: S) {
        this.store.set(id, state);
    }
}

interface TestState {
    value: number;
    title: string;
    line: { id: string, qty: number }[];
}

describe('LiveAggregateDepot & createLiveAggregate', () => {
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
                lineUpdated: (state: any, event: Event<{lineId: string, qty: number}>) => {
                    // Logics
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
        const depot = new MockDepot<TestState>();
        const liveDepot = new MirageDepot(builder, depot);
        
        const live = await liveDepot.findById('agg-1');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        
        expect(bridge._state.value).toBe(0);
        expect(bridge.id).toBe('agg-1');
    });

    test('should load existing state from depot', async () => {
        const builder = setupBuilder();
        const depot = new MockDepot<TestState>();
        depot._setMockState('agg-2', { value: 10, title: 'Loaded', line: [] });

        const liveDepot = new MirageDepot(builder, depot);
        const live = await liveDepot.findById('agg-2');
        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        
        expect(bridge._state.value).toBe(10);
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

        await (live as any).line['123'].update({ qty: 99 });
        
        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        const uncommitted = bridge.getUncommittedEvents();

        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.line.updated.event');
        expect(uncommitted[0].payload).toEqual({ qty: 99, lineId: '123', id: '123' });
    });

    test('save() persists state and clears uncommitted', async () => {
        const builder = setupBuilder();
        const depot = new MockDepot<TestState>();
        let saveCalled = false;
        depot.save = async (state) => {
            saveCalled = true;
            return state;
        };

        const liveDepot = new MirageDepot(builder, depot);
        const live = liveDepot.new('agg-1');
        
        await live.update(55);

        const bridge = createLegacyAggregateBridge<TestState, any>(live);
        expect(bridge.getUncommittedEvents().length).toBe(1);
        
        await liveDepot.save(live);

        expect(saveCalled).toBe(true);
        expect(bridge.getUncommittedEvents().length).toBe(0);
    });

    test('should allow reading readable states directly from live object natively', async () => {
        const builder = setupBuilder();
        const depot = new MockDepot<TestState>();
        depot._setMockState('agg-r', { value: 777, title: 'ReadModel', line: [{id: 'abc', qty: 5}] });

        const liveDepot = new MirageDepot(builder, depot);
        const live = await liveDepot.findById('agg-r');
        
        expect(live.value).toBe(777);
        expect(live.title).toBe('ReadModel');
        
        // Native array functions shouldn't break proxy structure
        const firstLine = live.line[0];
        expect(firstLine.id).toBe('abc');
        expect(firstLine.qty).toBe(5);
        expect(live.line.map((x: any) => x.qty)).toEqual([5]);
        
        // Calling flat commands still behaves dynamically returning properly bounded Promise
        await live.update(888);
        expect(live.value).toBe(888);
    });

});
