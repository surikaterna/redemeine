
import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, extractUncommittedEvents, clearUncommittedEvents, subscribe, MirageCoreSymbol, type MirageSetup } from '../src/createMirage';
import { Event, RedemeinePlugin, type Contract } from '@redemeine/kernel';
import { MirageCore } from '../src/MirageCore';

interface TestState {
    value: number;
    title: string;
    line: { id: string, qty: number }[];
}

type VersionState = { version: string; value: number };
const versionCore = (live: unknown) => (live as { [MirageCoreSymbol]: MirageCore<VersionState> })[MirageCoreSymbol];
const versionEvent = (value: number): Event => ({ type: 'counter.changed.event', payload: value });
const versionBuilder = () => createAggregate('counter', { version: 'domain', value: 0 })
    .events({ changed: (state, event: Event<number>) => {
        if (event.payload === -1) throw new Error('apply failed');
        state.value = event.payload;
    } })
    .commands(() => ({ batch: {
        pack: (events: Event[]) => ({ events }),
        handler: (_state, payload) => payload.events
    } }))
    .build();

describe('event-count version contract', () => {
    test.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1])('guards each live event at baseline %s, retaining only the valid prefix', (initialVersion) => {
        const builder = versionBuilder();
        const apply = jest.spyOn(builder, 'apply');
        const live = createMirage(builder, 'ceiling', { initialVersion });
        const observed: number[] = [];
        builder.hooks = { onEventApplied: () => { observed.push(versionCore(live).version); } };
        const listener = jest.fn();
        subscribe(live, listener);
        const prefixCount = Number.MAX_SAFE_INTEGER - initialVersion;
        expect(() => live.batch([versionEvent(1), versionEvent(2), versionEvent(3)])).toThrow(RangeError);
        expect(versionCore(live).version).toBe(Number.MAX_SAFE_INTEGER);
        expect(live.value).toBe(prefixCount);
        expect(extractUncommittedEvents(live)).toHaveLength(prefixCount);
        expect(apply).toHaveBeenCalledTimes(prefixCount);
        expect(observed).toEqual(prefixCount ? [Number.MAX_SAFE_INTEGER] : []);
        expect(listener).not.toHaveBeenCalled();
        expect(() => live.batch([versionEvent(4)])).toThrow('Number.MAX_SAFE_INTEGER');
        expect(() => live.batch([versionEvent(5)])).toThrow(RangeError);
        expect(apply).toHaveBeenCalledTimes(prefixCount);
        expect(extractUncommittedEvents(live)).toHaveLength(prefixCount);
        expect(versionCore(live).version).toBe(Number.MAX_SAFE_INTEGER);
    });

    test('allows the last safe live event and zero-event commands at the ceiling', () => {
        const live = createMirage(versionBuilder(), 'ceiling', { initialVersion: Number.MAX_SAFE_INTEGER - 1 });
        const listener = jest.fn();
        subscribe(live, listener);
        live.batch([versionEvent(1)]);
        live.batch([]);
        expect(versionCore(live).version).toBe(Number.MAX_SAFE_INTEGER);
        expect(live.value).toBe(1);
        expect(extractUncommittedEvents(live)).toHaveLength(1);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('counts zero/one/many events, not commands, and preserves domain version', () => {
        const live = createMirage(versionBuilder(), 'v');
        const listener = jest.fn();
        subscribe(live, listener);
        expect(versionCore(live).version).toBe(0);
        expect(live.batch([])).not.toBeInstanceOf(Promise);
        expect(versionCore(live).version).toBe(0);
        live.batch([versionEvent(1)]);
        live.batch([versionEvent(2), versionEvent(3)]);
        expect(versionCore(live).version).toBe(3);
        expect(live.value).toBe(3);
        expect(live.version).toBe('domain');
        expect(extractUncommittedEvents(live)).toHaveLength(3);
        expect(listener).toHaveBeenCalledTimes(3);
        clearUncommittedEvents(live);
        expect(versionCore(live).version).toBe(3);
        expect(extractUncommittedEvents(live)).toEqual([]);
    });

    test.each(['apply', 'validation', 'event-hook'] as const)('retains applied prefix after %s failure', (failure) => {
        const builder = versionBuilder();
        const observations: number[] = [];
        const contract = {
            validateCommand: jest.fn(),
            validateEvent: (_type: string, payload: unknown) => {
                if (failure === 'validation' && payload === 2) throw new Error('validation failed');
            }
        } as unknown as Contract;
        const live = createMirage(builder, 'v', { contract });
        builder.hooks = { onEventApplied: () => {
            observations.push(versionCore(live).version);
            if (failure === 'event-hook') throw new Error('hook failed');
        } };
        const listener = jest.fn();
        subscribe(live, listener);
        const second = failure === 'apply' ? -1 : 2;
        expect(() => live.batch([versionEvent(1), versionEvent(second), versionEvent(3)])).toThrow();
        expect(versionCore(live).version).toBe(1);
        expect(live.value).toBe(1);
        expect(extractUncommittedEvents(live)).toMatchObject([versionEvent(1)]);
        expect(observations).toEqual([1]);
        expect(listener).not.toHaveBeenCalled();
    });

    test.each(['onBeforeCommand', 'onAfterCommand'] as const)('%s remains pre-apply on failure', (hook) => {
        const builder = versionBuilder();
        const live = createMirage(builder, 'v', { initialVersion: 5 });
        builder.hooks = { [hook]: () => {
            expect(live.value).toBe(0);
            expect(versionCore(live).version).toBe(5);
            throw new Error('pre-apply');
        } };
        expect(() => live.batch([versionEvent(1)])).toThrow('pre-apply');
        expect(versionCore(live).version).toBe(5);
        expect(extractUncommittedEvents(live)).toEqual([]);
    });

    test('before/after command observe old state; applied hooks observe each new count', async () => {
        const builder = versionBuilder();
        const observed: string[] = [];
        const live = createMirage(builder, 'v', { plugins: [{ key: 'async', onBeforeCommand: async () => {
            await Promise.resolve();
            observed.push(`plugin:${versionCore(live).version}`);
        } }] });
        builder.hooks = {
            onBeforeCommand: (_command, state) => { observed.push(`before:${state.value}:${versionCore(live).version}`); },
            onAfterCommand: (_command, _events, state) => { observed.push(`after:${state.value}:${versionCore(live).version}`); },
            onEventApplied: (_event, state) => { observed.push(`event:${state.value}:${versionCore(live).version}`); }
        };
        const result = live.batch([versionEvent(1), versionEvent(2)]);
        expect(result).toBeInstanceOf(Promise);
        await result;
        expect(observed).toEqual(['plugin:0', 'before:0:0', 'after:0:0', 'event:1:1', 'event:2:2']);
    });

    test('counts accepted unknown events but strict schema rejection does not count', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const unknown: Event = { type: 'counter.unknown.event', payload: {} };
            const live = createMirage(versionBuilder(), 'v');
            live.batch([versionEvent(1), unknown]);
            expect(versionCore(live).version).toBe(2);
            expect(live.value).toBe(1);
            const contract = { validateCommand: () => {}, validateEvent: () => { throw new Error('schema not found'); } } as unknown as Contract;
            const strict = createMirage(versionBuilder(), 'strict', { strict: true, contract });
            expect(() => strict.batch([unknown])).toThrow('schema not found');
            expect(versionCore(strict).version).toBe(0);
            expect(extractUncommittedEvents(strict)).toEqual([]);
        } finally { warn.mockRestore(); }
    });

    test('observer failure cannot roll back applied events', () => {
        const live = createMirage(versionBuilder(), 'v');
        subscribe(live, () => { throw new Error('observer'); });
        expect(() => live.batch([versionEvent(1), versionEvent(2)])).toThrow('observer');
        expect(versionCore(live).version).toBe(2);
        expect(extractUncommittedEvents(live)).toHaveLength(2);
    });

    test('async before-command plugin rejection leaves version and pending unchanged', async () => {
        const live = createMirage(versionBuilder(), 'v', { initialVersion: 4, plugins: [{
            key: 'fail-before', onBeforeCommand: async () => { throw new Error('before failed'); }
        }] });
        await expect(live.batch([versionEvent(1)])).rejects.toMatchObject({ hook: 'onBeforeCommand' });
        expect(versionCore(live).version).toBe(4);
        expect(live.value).toBe(0);
        expect(extractUncommittedEvents(live)).toEqual([]);
    });

    test('invalidates entity and selector caches before each event hook, including partial failure', () => {
        const entity = createEntity<{ id: string; qty: number }, 'item'>('item').events({}).build();
        const builder = createAggregate('cart', { items: [{ id: 'a', qty: 0 }] })
            .entityList('items', entity)
            .selectors({ selected: (state) => state.items })
            .events({ changed: (state, event: Event<number>) => {
                if (event.payload < 0) throw new Error('apply failed');
                state.items[0].qty = event.payload;
            } })
            .commands(() => ({ batch: {
                pack: (values: number[]) => ({ values }),
                handler: (_state, { values }) => values.map(payload => ({ type: 'cart.changed.event', payload }))
            } }))
            .build();
        const live = createMirage(builder, 'cache');
        const selected = live.selected().first()!;
        expect(live.items('a').qty).toBe(0);
        expect(selected.qty).toBe(0);
        const seen: number[][] = [];
        builder.hooks = { onEventApplied: () => { seen.push([versionCore(live).version, live.items('a').qty, selected.qty]); } };
        expect(() => live.batch([1, 2, -1])).toThrow('apply failed');
        expect(seen).toEqual([[1, 1, 1], [2, 2, 2]]);
        expect(live.selected().first()!.qty).toBe(2);
        expect(versionCore(live).version).toBe(2);
    });
});

describe('hydration event-count baseline', () => {
    test.each([
        ['array', Number.MAX_SAFE_INTEGER], ['async', Number.MAX_SAFE_INTEGER],
        ['array', Number.MAX_SAFE_INTEGER - 1], ['async', Number.MAX_SAFE_INTEGER - 1]
    ] as const)('rejects overflowing %s replay from %s before the offending plugin/apply', async (kind, initialVersion) => {
        const builder = versionBuilder();
        const apply = jest.spyOn(builder, 'apply');
        const hydrate = jest.fn();
        const events = [versionEvent(1), versionEvent(2), versionEvent(3)];
        const replay = kind === 'array' ? events : (async function* () { yield* events; })();
        await expect(createMirage(builder, 'ceiling', {
            snapshot: { version: 'snapshot', value: 0 }, initialVersion, events: replay,
            plugins: [{ key: 'hydrate', onHydrateEvent: hydrate }]
        })).rejects.toThrow(RangeError);
        const prefixCount = Number.MAX_SAFE_INTEGER - initialVersion;
        expect(apply).toHaveBeenCalledTimes(prefixCount);
        expect(hydrate).toHaveBeenCalledTimes(prefixCount);
        if (prefixCount) expect(apply).toHaveBeenCalledWith(expect.anything(), events[0]);
    });

    test.each(['array', 'async'] as const)('accepts the last safe %s snapshot-tail event', async (kind) => {
        const events = [versionEvent(1)];
        const replay = kind === 'array' ? events : (async function* () { yield* events; })();
        const live = await createMirage(versionBuilder(), 'ceiling', {
            snapshot: { version: 'snapshot', value: 0 }, initialVersion: Number.MAX_SAFE_INTEGER - 1, events: replay
        });
        expect(versionCore(live).version).toBe(Number.MAX_SAFE_INTEGER);
        expect(live.value).toBe(1);
        expect(extractUncommittedEvents(live)).toEqual([]);
        expect(() => live.batch([versionEvent(2)])).toThrow(RangeError);
        expect(live.value).toBe(1);
        expect(extractUncommittedEvents(live)).toEqual([]);
    });

    test.each(['array', 'iterable', 'async'] as const)('adds %s replay count without live effects', async (kind) => {
        const builder = versionBuilder();
        const hook = jest.fn();
        builder.hooks = { onBeforeCommand: hook, onAfterCommand: hook, onEventApplied: hook };
        const events = [versionEvent(7), versionEvent(8)];
        const replay = kind === 'array' ? events : kind === 'iterable'
            ? (function* () { yield* events; })() : (async function* () { yield* events; })();
        const live = await createMirage(builder, 'v', { snapshot: { version: 'snapshot', value: 6 }, initialVersion: 6, events: replay });
        expect(live.value).toBe(8);
        expect(versionCore(live).version).toBe(8);
        expect(extractUncommittedEvents(live)).toEqual([]);
        expect(hook).not.toHaveBeenCalled();
        expect(events.every(event => !('version' in event))).toBe(true);
        const fullReplay = kind === 'async' ? (async function* () { yield* events; })()
            : kind === 'iterable' ? (function* () { yield* events; })() : events;
        expect(versionCore(await createMirage(builder, 'full', { events: fullReplay })).version).toBe(2);
        live.batch([versionEvent(9)]);
        expect(versionCore(live).version).toBe(9);
    });

    test.each([0, 12, Number.MAX_SAFE_INTEGER])('preserves snapshot-only and empty-tail baseline %s', async (initialVersion) => {
        const setup = { snapshot: { version: 'snapshot', value: 9 }, initialVersion };
        const direct = createMirage(versionBuilder(), 'v', setup);
        expect(versionCore(direct).version).toBe(initialVersion);
        const empty = await createMirage(versionBuilder(), 'v', { ...setup, events: [] });
        expect(versionCore(empty).version).toBe(initialVersion);
    });

    test('state-only snapshot starts at zero; full replay starts at zero', async () => {
        const snapshot = createMirage(versionBuilder(), 'v', { snapshot: { version: 'domain', value: 100 } });
        expect(versionCore(snapshot).version).toBe(0);
        const replay = await createMirage(versionBuilder(), 'v', { events: [versionEvent(1), versionEvent(2)] });
        expect(versionCore(replay).version).toBe(2);
    });

    test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])('rejects invalid baseline %s before consuming events/plugins', (invalid) => {
        const consumed = jest.fn();
        const events = (function* () { consumed(); yield versionEvent(1); })();
        const plugin = jest.fn();
        expect(() => createMirage(versionBuilder(), 'v', {
            initialVersion: invalid as number, events, plugins: [{ key: 'hydrate', onHydrateEvent: plugin }]
        })).toThrow('nonnegative safe integer');
        expect(consumed).not.toHaveBeenCalled();
        expect(plugin).not.toHaveBeenCalled();
    });

    test('accepted replay skips count, while apply/plugin failures reject construction', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const live = await createMirage(versionBuilder(), 'v', { events: [{ type: 'unknown', payload: {} }] });
            expect(versionCore(live).version).toBe(1);
        } finally { warn.mockRestore(); }
        await expect(createMirage(versionBuilder(), 'v', { events: [versionEvent(1), versionEvent(-1)] })).rejects.toThrow('apply failed');
        await expect(createMirage(versionBuilder(), 'v', { events: [versionEvent(1)], plugins: [{
            key: 'fail', onHydrateEvent: () => { throw new Error('hydrate failed'); }
        }] })).rejects.toMatchObject({ hook: 'onHydrateEvent', pluginKey: 'fail' });
    });

    test('setup overloads preserve synchronous and replay types', () => {
        const builder = versionBuilder();
        const sync = createMirage(builder, 'v', { initialVersion: 0 });
        const value: number = sync.value;
        const replay: Promise<typeof sync> = createMirage(builder, 'v', { initialVersion: 3, events: [] });
        const setup: MirageSetup<VersionState> = { initialVersion: 0 };
        const optional: typeof sync | Promise<typeof sync> = createMirage(builder, 'v', setup);
        void [value, replay, optional];
        if (false) {
            // @ts-expect-error Baselines are numeric event counts, not final-version strings.
            createMirage(builder, 'v', { initialVersion: '3' });
        }
    });
});

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

    test('should initialize with initialState if no snapshot/events provided', () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');

        expect(live.value).toBe(0);
    });

    test('should load existing state from snapshot', () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-2', {
            snapshot: { value: 10, title: 'Loaded', line: [] }
        });

        expect(live.value).toBe(10);
        expect(live.title).toBe('Loaded');
    });

    test('should load existing state from events', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'agg-3', {
            events: [{ type: 'test.updated.event', payload: 42 }]
        });

        expect(live.value).toBe(42);
        expect(live.title).toBe('New');
    });

    test('supports direct array replay hydration without async setup', async () => {
        const builder = setupBuilder();
        const replayEvents: Event[] = [
            { type: 'test.updated.event', payload: 5 },
            { type: 'test.updated.event', payload: 12 }
        ];

        const live = await createMirage(builder, 'agg-3-array', {
            events: replayEvents
        });

        expect(live.value).toBe(12);
    });

    test('should load existing state from snapshot and events', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'agg-4', {
            snapshot: { value: 10, title: 'Loaded', line: [] },
            events: [{ type: 'test.updated.event', payload: 42 }]
        });

        expect(live.value).toBe(42);
        expect(live.title).toBe('Loaded');
    });

    test('should execute flat commands, update state & uncommitted', () => {
        const builder = setupBuilder();
        const live = createMirage(builder, 'agg-1');

        live.update(42);

        expect(live.value).toBe(42);

        const uncommitted = extractUncommittedEvents(live);
        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.updated.event');
        expect(uncommitted[0].payload).toBe(42);
    });

    test('should execute targeted commands via entity list', () => {
        const lineEntity = createEntity<{ id: string; qty: number }, 'line'>('line')
            .events({
                updated: (line, event: Event<{ id: string; qty: number }>) => {
                    line.qty = event.payload.qty;
                }
            })
            .commands((emit) => ({
                update: {
                    pack: (lineId: string, qty: number) => ({ id: lineId, qty }),
                    handler: (line, payload) => emit.updated(payload)
                }
            }))
            .build();

        interface LineTestState {
            value: number;
            line: { id: string; qty: number }[];
        }

        const aggregate = createAggregate<LineTestState, 'test'>('test', {
            value: 0,
            line: [{ id: '123', qty: 1 }]
        })
            .entityList('line', lineEntity)
            .events({
                updated: (state: any, event: Event<number>) => {
                    state.value = event.payload;
                }
            })
            .commands((emit) => ({
                update: (state: any, value: number) => emit.updated(value)
            }))
            .build();

        const live = createMirage(aggregate, 'agg-1');
        live.line('123').update(99);

        const uncommitted = extractUncommittedEvents(live);
        expect(uncommitted.length).toBe(1);
        expect(uncommitted[0].type).toBe('test.line.updated.event');
        expect(uncommitted[0].payload).toEqual({ id: '123', qty: 99 });
    });

    test('should allow reading readable states directly from live object natively', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'agg-r', {
            events: [{ type: 'test.updated.event', payload: 777 }]
        });

        expect(live.value).toBe(777); 

        // Native array functions shouldn't break proxy structure
        const firstLine = live.line[0];
        
        // Calling flat commands still behaves dynamically returning properly bounded state
        live.update(888);
        expect(live.value).toBe(888);
    });

    test('exposes selectors as typed callable functions on the root mirage', () => {
        const aggregate = createAggregate<TestState, 'test'>('test', initialState)
            .selectors({
                hasLine: (state, id: string) => state.line.some((x) => x.id === id),
                lineQty: (state, id: string) => state.line.find((x) => x.id === id)?.qty ?? 0
            })
            .events({})
            .commands(() => ({}))
            .build();

        const live = createMirage(aggregate, 'agg-sel');

        expect(live.hasLine('123')).toBe(true);
        expect(live.lineQty('123')).toBe(1);

        if (false) {
            const exists: boolean = live.hasLine('123');
            const qty: number = live.lineQty('123');
            void exists;
            void qty;
        }
    });

    test('injects selected list id into packed child command arguments', () => {
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
        live.addresses('primary').amend('123 Main St');
        live.addresses[0].amend('456 Side St');

        expect(live.addresses[0].street).toBe('456 Side St');

        const uncommitted = extractUncommittedEvents(live);
        expect(uncommitted[0].payload).toEqual({ id: 'primary', street: '123 Main St' });
        expect(uncommitted[1].payload).toEqual({ id: 'primary', street: '456 Side St' });
    });

    test('supports composite primary key targeting in entityList', () => {
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
        live.addresses({ country: 'US', label: 'primary' }).amend('123 Main St');
        expect(live.addresses[0].street).toBe('123 Main St');
    });

    test('supports entityMap key injection via property access', () => {
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
        live.identifiers.VAT.verify();

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

    test('runs onBeforeCommand plugins sequentially and can block command execution', async () => {
        type GuardState = { value: number };

        const aggregate = createAggregate<GuardState, 'guard'>('guard', { value: 0 })
            .events({
                incremented: {
                    projector: (state: GuardState, event: Event<number>) => {
                        state.value = event.payload;
                    },
                    meta: { eventPolicy: 'mutatesValue' }
                }
            })
            .commands((emit) => {
                return {
                    increment: {
                        handler: (state: GuardState, payload: number) => emit.incremented(payload),
                        meta: { requiredRole: 'writer' }
                    }
                };
            })
            .build();

        const calls: string[] = [];
        const plugins: RedemeinePlugin[] = [
            {
                key: 'before-first',
                onBeforeCommand: async (ctx) => {
                    calls.push(`first:${ctx.pluginKey}:${String((ctx.meta as any)?.requiredRole)}:${ctx.commandType}`);
                }
            },
            {
                key: 'before-second',
                onBeforeCommand: async (ctx) => {
                    calls.push(`second:${ctx.pluginKey}:${ctx.commandType}`);
                    if ((ctx.payload as number) < 0) {
                        throw new Error('blocked');
                    }
                }
            }
        ];

        const allowed = createMirage(aggregate, 'g-1', { plugins });
        await allowed.increment(5);
        expect(allowed.value).toBe(5);
        expect(calls).toEqual([
            'first:before-first:writer:guard.increment.command',
            'second:before-second:guard.increment.command'
        ]);

        const blocked = createMirage(aggregate, 'g-2', { plugins });
        await expect(blocked.increment(-1)).rejects.toThrow('blocked');
        expect(blocked.value).toBe(0);
    });

    test('runs onHydrateEvent plugins during createMirage setup events with mutation and replacement semantics', async () => {
        type HydrateState = { total: number };

        const aggregate = createAggregate<HydrateState, 'hydrate'>('hydrate', { total: 0 })
            .events({
                added: {
                    projector: (state: HydrateState, event: Event<{ amount: number }>) => {
                        state.total += event.payload.amount;
                    },
                    meta: { stage: 'hydration' }
                }
            })
            .commands(() => ({}))
            .build();

        const seen: string[] = [];
        const plugins: RedemeinePlugin[] = [
            {
                key: 'hydrate-first',
                onHydrateEvent: async (ctx) => {
                    seen.push(`first:${ctx.pluginKey}:${ctx.eventType}:${String((ctx.meta as any)?.stage)}`);
                    (ctx.payload as any).amount += 1;
                }
            },
            {
                key: 'hydrate-second',
                onHydrateEvent: async (ctx) => {
                    seen.push(`second:${ctx.pluginKey}:${ctx.eventType}`);
                    return { amount: (ctx.payload as any).amount * 10 };
                }
            }
        ];

        const mirage = await createMirage(aggregate, 'h-1', {
            events: [
                { type: 'hydrate.added.event', payload: { amount: 1 } },
                { type: 'hydrate.added.event', payload: { amount: 2 } }
            ],
            plugins
        });

        expect(mirage.total).toBe(50);
        expect(seen).toEqual([
            'first:hydrate-first:hydrate.added.event:hydration',
            'second:hydrate-second:hydrate.added.event',
            'first:hydrate-first:hydrate.added.event:hydration',
            'second:hydrate-second:hydrate.added.event'
        ]);
    });

    test('composes builder plugins before runtime plugins', async () => {
        type GuardState = { value: number };

        const order: string[] = [];
        const builderPlugin: RedemeinePlugin = {
            key: 'builder',
            onBeforeCommand: async () => {
                order.push('builder');
            }
        };
        const runtimePlugin: RedemeinePlugin = {
            key: 'runtime',
            onBeforeCommand: async () => {
                order.push('runtime');
            }
        };

        const aggregate = createAggregate<GuardState, 'guard'>('guard', { value: 0 })
            .plugins(builderPlugin)
            .events({
                incremented: (state: GuardState, event: Event<number>) => {
                    state.value = event.payload;
                }
            })
            .commands((emit) => ({
                increment: (state: GuardState, payload: number) => emit.incremented(payload)
            }))
            .build();

        const mirage = createMirage(aggregate, 'g-1', { plugins: [runtimePlugin] });
        await mirage.increment(1);

        expect(order).toEqual(['builder', 'runtime']);
    });

});
