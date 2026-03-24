import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createEntity } from '../src/createEntity';
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
        const bridge = createLegacyAggregateBridge(live);

        expect(bridge._state.value).toBe(0);
        expect(bridge.id).toBe('agg-1');
    });

    test('should load existing state from snapshot', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-2', {
            snapshot: { value: 10, title: 'Loaded', line: [] }
        });
        
        const bridge = createLegacyAggregateBridge(live);

        expect(bridge._state.value).toBe(10);
        expect(bridge._state.title).toBe('Loaded');
    });

    test('should load existing state from events', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-3', {
            events: [{ type: 'test.updated.event', payload: 42 }]
        });
        const bridge = createLegacyAggregateBridge(live);

        expect(bridge._state.value).toBe(42);
        expect(bridge._state.title).toBe('New');
    });

    test('should load existing state from snapshot and events', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-4', {
            snapshot: { value: 10, title: 'Loaded', line: [] },
            events: [{ type: 'test.updated.event', payload: 42 }]
        });
        const bridge = createLegacyAggregateBridge(live);

        expect(bridge._state.value).toBe(42);
        expect(bridge._state.title).toBe('Loaded');
    });

    test('should execute flat commands, update state & uncommitted', async () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');
        const bridge = createLegacyAggregateBridge(live);

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

        const bridge = createLegacyAggregateBridge(live);
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

    test('injects selected list id into packed child command arguments', async () => {
        type PartyState = {
            addresses: { id: string; street: string }[];
        };

        const addressEntity = createEntity<{ id: string; street: string }, 'address'>('address')
            .events({ amended: (address, event: Event<{ id: string; street: string }>) => { address.street = event.payload.street; } })
            .commands((emit) => ({
                amend: {
                    pack: (id: string, street: string) => ({ id, street }),
                    handler: (address, payload) => emit.amended(payload)
                }
            }))
            .build();

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            addresses: [{ id: 'primary', street: 'Old' }]
        })
            .entityList('addresses', addressEntity)
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');
        await live.addresses('primary').amend('123 Main St');
        await live.addresses[0].amend('456 Side St');

        expect(live.addresses[0].street).toBe('456 Side St');

        const bridge = createLegacyAggregateBridge(live);
        const uncommitted = bridge.getUncommittedEvents();
        expect(uncommitted[0].payload).toEqual({ id: 'primary', street: '123 Main St' });
        expect(uncommitted[1].payload).toEqual({ id: 'primary', street: '456 Side St' });
    });

    test('supports composite primary key targeting in entityList', async () => {
        type PartyState = {
            addresses: { country: string; label: string; street: string }[];
        };

        const addressEntity = createEntity<{ country: string; label: string; street: string }, 'address'>('address')
            .events({ amended: (address, event: Event<{ country: string; label: string; street: string }>) => { address.street = event.payload.street; } })
            .commands((emit) => ({
                amend: {
                    pack: (country: string, label: string, street: string) => ({ country, label, street }),
                    handler: (address, payload) => emit.amended(payload)
                }
            }))
            .build();

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            addresses: [{ country: 'US', label: 'primary', street: 'Old' }]
        })
            .entityList('addresses', addressEntity, { pk: ['country', 'label'] })
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');
        await live.addresses({ country: 'US', label: 'primary' }).amend('123 Main St');
        expect(live.addresses[0].street).toBe('123 Main St');
    });

    test('supports entityMap key injection via property access', async () => {
        type PartyState = {
            identifiers: Record<string, { verified: boolean }>;
        };

        const identifierEntity = createEntity<{ verified: boolean }, 'identifier'>('identifier')
            .events({ verified: (identifier) => { identifier.verified = true; } })
            .commands((emit) => ({
                verify: {
                    pack: (identifierKey: string) => ({ identifierKey }),
                    handler: (identifier, payload) => emit.verified(payload)
                }
            }))
            .build();

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            identifiers: {
                VAT: { verified: false },
                EIN: { verified: false }
            }
        })
            .entityMap('identifiers', identifierEntity, { knownKeys: ['VAT', 'EIN'] as const })
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');
        await (live as any).identifiers.VAT.verify();

        expect(live.identifiers.VAT.verified).toBe(true);
    });

    test('valueObject branches are read-only and do not expose command routing', () => {
        type PartyState = {
            preferences: { theme: string };
        };

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            preferences: { theme: 'light' }
        })
            .valueObject('preferences', {})
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');

        expect(live.preferences.theme).toBe('light');
        expect(() => {
            (live as any).preferences.theme = 'dark';
        }).toThrow('Cannot mutate properties directly');
        expect((live as any).preferences.setTheme).toBeUndefined();
    });

    test('valueObjectList and valueObjectMap are read-only and non-callable', () => {
        type PartyState = {
            aliases: { label: string }[];
            preferencesByRegion: Record<string, { theme: string }>;
        };

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            aliases: [{ label: 'home' }],
            preferencesByRegion: { US: { theme: 'light' } }
        })
            .valueObjectList('aliases', {})
            .valueObjectMap('preferencesByRegion', {})
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');

        expect(live.aliases[0].label).toBe('home');
        expect(live.preferencesByRegion.US.theme).toBe('light');
        expect(typeof (live as any).aliases).toBe('object');
        expect(typeof (live as any).preferencesByRegion).toBe('object');

        expect(() => {
            (live as any).aliases.push({ label: 'work' });
        }).toThrow('Cannot mutate properties directly');

        expect(() => {
            (live as any).preferencesByRegion.US.theme = 'dark';
        }).toThrow('Cannot mutate properties directly');

        expect((live as any).aliases.add).toBeUndefined();
        expect((live as any).preferencesByRegion.setTheme).toBeUndefined();
    });

    test('valueObject collection types are not callable', () => {
        type PartyState = {
            aliases: { label: string }[];
            preferencesByRegion: Record<string, { theme: string }>;
        };

        const aggregate = createAggregate<PartyState, 'party'>('party', {
            aliases: [{ label: 'home' }],
            preferencesByRegion: { US: { theme: 'light' } }
        })
            .valueObjectList('aliases', {})
            .valueObjectMap('preferencesByRegion', {})
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'p1');

        if (false) {
            // @ts-expect-error valueObjectList should not expose callable accessor
            live.aliases('home');
            // @ts-expect-error valueObjectMap should not expose callable accessor
            live.preferencesByRegion('US');
        }

        expect(live.aliases[0].label).toBe('home');
        expect(live.preferencesByRegion.US.theme).toBe('light');
    });

});
