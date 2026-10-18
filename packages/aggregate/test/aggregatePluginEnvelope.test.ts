import type { Command, Event } from '@redemeine/kernel';
import { produce } from 'immer';
import { z } from 'zod';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

const instant = '2026-10-16T10:00:00.000Z';
function domain() {
  return createAggregate('order', { total: 0 })
    .events({ added(state, event: Event<{ amount: number }>) { state.total += event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload) })).build();
}
function datePlugin(clock: () => Date) {
  return createAggregatePlugin('audit').state(() => ({ dates: [] as string[], refs: [] as string[] }))
    .commandEnvelope(input => {
      const dateTime = input.dateTime === undefined ? clock() : input.dateTime;
      if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) throw new TypeError('Invalid dateTime');
      return { dateTime };
    })
    .eventEnvelope((_, context) => {
      expect(context.event.id).toBeTruthy();
      expect(context.event.metadata?.command).toMatchObject({ id: context.command.id, type: context.command.type });
      return { sourceCommandDateTime: new Date(context.command.dateTime.getTime()), auditRef: context.command.id! };
    })
    .onEvent((draft, event) => {
      const stamp: unknown = Reflect.get(event, 'sourceCommandDateTime');
      const ref: unknown = Reflect.get(event, 'auditRef');
      if (stamp instanceof Date && Number.isFinite(stamp.getTime()) && typeof ref === 'string') {
        draft.dates.push(stamp.toISOString());
        draft.refs.push(ref);
      }
    }).build();
}

describe('aggregate envelope runtime', () => {
  test('possibly absent configured descriptors do not install either extension', () => {
    const stamp = datePlugin(() => new Date(instant));
    function configured(enabled: boolean) {
      return { ...stamp, commandEnvelope: enabled ? stamp.commandEnvelope : undefined,
        eventEnvelope: enabled ? stamp.eventEnvelope : undefined };
    }
    const host = domain().withPlugins(configured(false));
    const raw = host.commandCreators.add({ amount: 1 });
    expect(host.prepareCommand(host.initialState, raw)).not.toHaveProperty('dateTime');
    expect(host.process(host.initialState, raw)[0]).not.toHaveProperty('sourceCommandDateTime');
  });

  test('source envelope preparation applies to descendant and raw payloads without narrowing them', () => {
    const parent = createAggregate('parent', { total: 0 })
      .events({ added(state, event: Event<{ amount: number }>) { state.total += event.payload.amount; } })
      .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload) }));
    const seenCommands: unknown[] = [];
    const seenEvents: unknown[] = [];
    const plugin = createAggregatePluginFor(parent.build(), 'wildcard').state(() => ({}))
      .commandEnvelope((_, context) => {
        seenCommands.push(context.command.payload);
        return { commandStamp: true };
      }).eventEnvelope((_, context) => {
        expect(context.command.commandStamp).toBe(true);
        seenEvents.push(context.event.payload);
        return { eventStamp: true };
      }).build();
    const child = createAggregate('child', { total: 0 }).extends(parent).plugins(plugin)
      .events({ messaged(_state, _event: Event<{ message: string }>) {} })
      .commands(emit => ({ message: (_state, payload: { message: string }) => emit.messaged(payload) })).build();
    const raw = { type: child.commandCreators.message({ message: 'typed' }).type, payload: { external: true } };
    for (const command of [child.commandCreators.message({ message: 'typed' }), raw]) {
      expect(child.prepareCommand(child.initialState, command)).toHaveProperty('commandStamp', true);
      expect(child.process(child.initialState, command)[0]).toHaveProperty('eventStamp', true);
    }
    expect(seenCommands).toContainEqual({ message: 'typed' });
    expect(seenCommands).toContainEqual({ external: true });
    expect(seenEvents).toEqual([{ message: 'typed' }, { external: true }]);
  });

  test.each(['aggregateId', 'aggregateType', 'correlationId', 'causationId'])('rejects malformed command routing %s before callbacks', key => {
    const initialize = jest.fn(() => ({ stamp: true }));
    const host = domain().withPlugins(createAggregatePlugin('routing').state(() => ({})).commandEnvelope(initialize).build());
    for (const value of [42, false, null, {}, []]) {
      const raw = { ...host.commandCreators.add({ amount: 1 }), [key]: value };
      expect(() => host.prepareCommand(host.initialState, raw)).toThrow(`Invalid envelope routing field: ${key}`);
      expect(() => host.process(host.initialState, raw)).toThrow(`Invalid envelope routing field: ${key}`);
    }
    expect(initialize).not.toHaveBeenCalled();
    const valid = { ...host.commandCreators.add({ amount: 1 }), [key]: 'exact-name' };
    expect(host.prepareCommand(host.initialState, valid)).toHaveProperty(key, 'exact-name');
  });

  test('rejects malformed event routing before event callbacks', () => {
    const initialize = jest.fn(() => ({ stamp: true }));
    for (const key of ['aggregateId', 'aggregateType', 'correlationId', 'causationId']) {
      const base = createAggregate('routing', {}).events({ emitted() {} })
        .commands(() => ({ emit: () => ({ type: 'routing.emitted.event', payload: {}, [key]: false }) })).build();
      const host = base.withPlugins(createAggregatePlugin('routing').state(() => ({})).eventEnvelope(initialize).build());
      expect(() => host.process(host.initialState, host.commandCreators.emit())).toThrow(`Invalid envelope routing field: ${key}`);
    }
    expect(initialize).not.toHaveBeenCalled();
  });

  test('fixed-clock command preparation precedes processing; events are linked, routed and replayable', () => {
    const clock = jest.fn(() => new Date(instant));
    const host = domain().withPlugins(datePlugin(clock));
    const raw = { ...host.commandCreators.add({ amount: 2 }), aggregateId: 'order-1', aggregateType: 'order',
      correlationId: 'incoming', headers: { commandSummary: { amount: 2 }, commandStoreRef: 'store:1' }, metadata: { trace: 'trace' } };
    expect(Reflect.get(raw, 'dateTime')).toBeUndefined();
    const command = host.prepareCommand(host.initialState, raw);
    expect(command.dateTime).toEqual(new Date(instant));
    expect(command.id).toBeTruthy();
    expect(command).toMatchObject({ aggregateId: 'order-1', aggregateType: 'order', correlationId: 'incoming', metadata: { trace: 'trace' } });
    const events = host.process(host.initialState, command);
    expect(events[0]).toMatchObject({ sourceCommandDateTime: new Date(instant), auditRef: command.id,
      aggregateId: 'order-1', aggregateType: 'order', correlationId: command.id,
      metadata: { command: { id: command.id, type: command.type, summary: { amount: 2 }, storeRef: 'store:1' } } });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(host.initialState.audit).toEqual({ dates: [], refs: [] });
    const live = events.reduce((state, event) => host.apply(state, event), host.initialState);
    clock.mockImplementation(() => { throw new Error('replay called clock'); });
    const replay = events.reduce((state, event) => host.apply(state, event), host.initialState);
    expect(replay).toEqual(live);
    expect(live).toEqual({ total: 2, audit: { dates: [instant], refs: [command.id] } });
    expect(produce(host.initialState, draft => host.applyToDraft(draft, events[0]!))).toEqual(live);
  });

  test('direct raw process prepares; supplied dates and reconstructed retries do not call clock', () => {
    const clock = jest.fn(() => { throw new Error('must not clock'); });
    const host = domain().withPlugins(datePlugin(clock));
    const supplied = new Date(instant);
    const raw = { ...host.commandCreators.add({ amount: 1 }), id: 'command-1', dateTime: supplied };
    const command = host.prepareCommand(host.initialState, raw);
    expect(command.dateTime).toEqual(supplied);
    expect(command.dateTime).not.toBe(supplied);
    const reconstructed = { ...JSON.parse(JSON.stringify(command)), dateTime: new Date(command.dateTime.toISOString()) };
    expect(host.process(host.initialState, reconstructed)[0]!.sourceCommandDateTime).toEqual(supplied);
    expect(host.process(host.initialState, raw)[0]!.auditRef).toBe('command-1');
    expect(clock).not.toHaveBeenCalled();
    for (const dateTime of [new Date(NaN), '2026-10-16', null, 0]) {
      expect(() => host.prepareCommand(host.initialState, { ...raw, dateTime })).toThrow('Invalid dateTime');
    }
  });

  test('same-object dedup validates detached snapshots including mutated dates, routing, headers and identity', () => {
    const initialize = jest.fn((input: Readonly<Record<string, unknown>>) => ({ dateTime: input.dateTime instanceof Date ? input.dateTime : new Date(instant) }));
    const host = domain().withPlugins(createAggregatePlugin('stamp').state(() => ({})).commandEnvelope(initialize).build());
    const prepared = host.prepareCommand(host.initialState, host.commandCreators.add({ amount: 1 }));
    expect(host.prepareCommand(host.initialState, prepared)).toBe(prepared);
    expect(initialize).toHaveBeenCalledTimes(1);
    prepared.dateTime.setTime(0);
    const changed = host.prepareCommand(host.initialState, prepared);
    expect(changed).not.toBe(prepared);
    expect(changed.dateTime.getTime()).toBe(0);
    changed.id = 'replacement';
    changed.aggregateId = 'new-route';
    changed.headers = { sink: 'new' };
    const rerouted = host.prepareCommand(host.initialState, changed);
    expect(rerouted).toMatchObject({ id: 'replacement', aggregateId: 'new-route', headers: { sink: 'new' } });
    expect(initialize).toHaveBeenCalledTimes(3);
    const other = host.withPlugins(createAggregatePlugin('extra').state(() => ({})).build());
    expect(other.prepareCommand(other.initialState, rerouted)).not.toBe(rerouted);
  });

  test('no envelope plan preserves command reference and domain output behavior', () => {
    const base = domain();
    const raw = base.commandCreators.add({ amount: 1 });
    expect(base.prepareCommand(base.initialState, raw)).toBe(raw);
    const host = base.withPlugins(createAggregatePlugin('empty').state(() => ({})).build());
    expect(host.prepareCommand(host.initialState, raw)).toBe(raw);
    expect(host.process).toBe(base.process);
    expect(host.process(host.initialState, raw)[0]).not.toHaveProperty('correlationId');
  });

  test.each(['aggregateId', 'aggregateType', 'correlationId', 'causationId'])('inactive direct preparation validates %s before its no-op', key => {
    const base = domain();
    const stateOnly = base.withPlugins(createAggregatePlugin('empty').state(() => ({})).build());
    // Intentional runtime migration boundary: inactive preparation must not inspect namespaces.
    const missing = base.initialState as typeof stateOnly.initialState;
    for (const host of [base, base.withPlugins({ key: 'legacy' }), stateOnly]) {
      // A missing plugin namespace and hostile payload prove validation precedes state/data work.
      const payload = { get amount(): number { throw new Error('payload read'); } };
      for (const value of [42, false, null, {}, []]) {
        const raw = { type: 'order.add.command', payload, [key]: value };
        expect(() => host.prepareCommand(missing, raw)).toThrow(`Invalid envelope routing field: ${key}`);
      }
      for (const routing of [{}, { [key]: undefined }, { [key]: 'exact-name' }]) {
        const raw = { type: 'order.add.command', payload, ...routing };
        expect(host.prepareCommand(missing, raw)).toBe(raw);
        expect(raw).not.toHaveProperty('id');
      }
      expect(host.process).toBe(base.process);
      const malformed = { ...base.commandCreators.add({ amount: 1 }), [key]: 42 };
      expect(() => host.process(stateOnly.initialState, malformed)).not.toThrow();
    }
  });

  test('canonical projection preserves core data, drops unowned extras, and detaches all caller aliases', () => {
    const base = domain();
    const host = base.withPlugins(datePlugin(() => new Date(instant)));
    const raw = { ...base.commandCreators.add({ amount: 1 }), headers: { custom: { date: new Date(instant) } },
      metadata: { info: { count: 1 } }, arbitrary: { unsafe: true } };
    const command = host.prepareCommand(host.initialState, raw);
    expect(command).not.toHaveProperty('arbitrary');
    expect(command.payload).not.toBe(raw.payload);
    expect(command.headers).not.toBe(raw.headers);
    expect(command.metadata).not.toBe(raw.metadata);
    raw.payload.amount = 9;
    raw.headers.custom.date.setTime(0);
    raw.metadata.info.count++;
    expect(command.payload.amount).toBe(1);
    expect(command.headers?.custom).toEqual({ date: new Date(instant) });
    expect(command.metadata?.info).toEqual({ count: 1 });
    command.headers = { sink: true };
    Object.assign(command, { status: 'queued' });
    expect(command.headers.sink).toBe(true);
  });

  test('readonly initializer/recipe snapshots protect aggregate, own state, input and canonical command', () => {
    const base = createAggregate('state', { date: new Date(instant), nested: { count: 0 } })
      .events({ added(_state, _event: Event<void>) {} }).commands(emit => ({ add: () => emit.added(undefined) })).build();
    const caller = { ...base.commandCreators.add(), extra: { count: 1 }, dateTime: new Date(instant) };
    const plugin = createAggregatePluginFor(base, 'own').state(() => ({ date: new Date(instant), count: 0 }))
      .commandEnvelope((input, context) => {
        expect(() => Reflect.set(context.state.nested, 'count', 3)).not.toThrow();
        expect(Reflect.set(context.ownState, 'count', 1)).toBe(false);
        expect(Reflect.set(input.extra as object, 'count', 2)).toBe(false);
        expect(Reflect.set(context.command, 'id', 'bad')).toBe(false);
        (context.state.date as Date).setTime(0);
        (context.ownState.date as Date).setTime(0);
        return { dateTime: input.dateTime as Date, nested: { count: 0 } };
      }).prepareCommand((draft, context) => {
        expect(context.state.date.getTime()).toBe(new Date(instant).getTime());
        draft.nested.count++;
      }).build();
    const host = base.withPlugins(plugin);
    const command = host.prepareCommand(host.initialState, caller);
    expect(host.initialState.date).toEqual(new Date(instant));
    expect(host.initialState.own).toEqual({ date: new Date(instant), count: 0 });
    expect(caller.extra.count).toBe(1);
    expect(command.nested.count).toBe(1);
    expect(command.dateTime).not.toBe(caller.dateTime);
  });

  test('multiple plugins compose disjoint extensions and event contexts contain only own command extension', () => {
    const base = domain();
    const a = createAggregatePlugin('a').state(() => ({})).commandEnvelope(() => ({ aCommand: 'a' }))
      .eventEnvelope((_, context) => {
        expect(context.command).toHaveProperty('aCommand', 'a');
        expect(context.command).not.toHaveProperty('bCommand');
        return { aEvent: 'a' };
      }).build();
    const b = createAggregatePlugin('b').state(() => ({})).commandEnvelope(() => ({ bCommand: 'b' }))
      .eventEnvelope((_, context) => {
        expect(context.command).toHaveProperty('bCommand', 'b');
        expect(context.command).not.toHaveProperty('aCommand');
        return { bEvent: 'b' };
      }).build();
    const host = base.withPlugins(a).withPlugins(b);
    expect(host.process(host.initialState, base.commandCreators.add({ amount: 1 }))[0]).toMatchObject({ aEvent: 'a', bEvent: 'b' });
    const collide = createAggregatePlugin('collision').state(() => ({})).commandEnvelope(() => ({ aCommand: true })).build();
    const bad = host.withPlugins(collide);
    expect(() => bad.process(bad.initialState, base.commandCreators.add({ amount: 1 }))).toThrow('collision');
    const eventCollision = base.withPlugins(a, createAggregatePlugin('eventCollision').state(() => ({})).eventEnvelope(() => ({ aEvent: 1 })).build());
    expect(() => eventCollision.process(eventCollision.initialState, base.commandCreators.add({ amount: 1 }))).toThrow('collision');
  });

  test('parses initializer and final recipe output and publishes parser transformations (real optional Zod)', () => {
    const parser = { parse: jest.fn((input: unknown) => z.object({ count: z.number() }).parse(input)) };
    const plugin = createAggregatePlugin('parsed').state(() => ({}))
      .commandEnvelope(() => ({ count: 1, stripped: true }), parser)
      .prepareCommand(draft => { draft.count++; }).build();
    const host = domain().withPlugins(plugin);
    const command = host.prepareCommand(host.initialState, host.commandCreators.add({ amount: 1 }));
    expect(command).toHaveProperty('count', 2);
    expect(command).not.toHaveProperty('stripped');
    expect(parser.parse).toHaveBeenCalledTimes(2);
    const invalid = domain().withPlugins(createAggregatePlugin('invalid').state(() => ({}))
      .commandEnvelope(() => ({ count: 1 }), parser).prepareCommand(draft => { Reflect.set(draft, 'count', 'bad'); }).build());
    expect(() => invalid.prepareCommand(invalid.initialState, invalid.commandCreators.add({ amount: 1 }))).toThrow();
  });

  test('final parser result, not preparse recipe object, is published', () => {
    const parser = { parse: (value: unknown) => ({ count: Number(Reflect.get(value as object, 'count')) + 1 }) };
    const host = domain().withPlugins(createAggregatePlugin('transform').state(() => ({}))
      .eventEnvelope(() => ({ count: 0 }), parser).prepareEvent(draft => { draft.count += 10; }).build());
    expect(host.process(host.initialState, host.commandCreators.add({ amount: 1 }))[0]).toHaveProperty('count', 12);
  });

  test('event recipes and reducers cannot leak snapshot Date mutations into command/event/state', () => {
    const base = domain();
    const plugin = createAggregatePlugin('snapshot').state(() => ({ count: 0 }))
      .commandEnvelope(() => ({ dateTime: new Date(instant) }))
      .eventEnvelope((_, context) => ({ sourceDate: new Date(context.command.dateTime.getTime()) }))
      .prepareEvent((draft, context) => {
        (context.command.dateTime as Date).setTime(0);
        const event = context.event as Event;
        expect(Reflect.set(event.payload as object, 'amount', 999)).toBe(false);
        draft.sourceDate.setTime(new Date(instant).getTime());
      }).onEvent((draft, event) => {
        const date = Reflect.get(event, 'sourceDate') as Date;
        date.setTime(0);
        expect(Reflect.set(event, 'id', 'bad')).toBe(false);
        draft.count++;
      }).build();
    const host = base.withPlugins(plugin);
    const command = host.prepareCommand(host.initialState, host.commandCreators.add({ amount: 1 }));
    const event = host.process(host.initialState, command)[0]!;
    const result = host.apply(host.initialState, event);
    expect(result.total).toBe(1);
    expect(command.dateTime).toEqual(new Date(instant));
    expect(event.sourceDate).toEqual(new Date(instant));
    expect(event.id).not.toBe('bad');
    expect(host.initialState.snapshot.count).toBe(0);
  });

  test.each(['id', 'type', 'payload', 'headers', 'metadata', 'aggregateId', 'aggregateType', 'correlationId', 'causationId', 'address', 'correlation', 'then', '__proto__', 'constructor', 'prototype', 'toString'])('rejects reserved extension key %s at runtime', key => {
    const host = domain().withPlugins(createAggregatePlugin('bad').state(() => ({}))
      .commandEnvelope((): object => Object.fromEntries([[key, 1]])).build());
    expect(() => host.prepareCommand(host.initialState, host.commandCreators.add({ amount: 1 }))).toThrow('Reserved');
  });

  test.each([null, [], new Date(), 1])('rejects nonplain initializer output %p', value => {
    const host = domain().withPlugins(createAggregatePlugin('bad').state(() => ({})).commandEnvelope(() => value as object).build());
    expect(() => host.prepareCommand(host.initialState, host.commandCreators.add({ amount: 1 }))).toThrow('plain object');
  });

  test('guards reserved recipe/parser output and replacement recipes', () => {
    const base = domain();
    const plugins = [
      createAggregatePlugin('bad').state(() => ({})).commandEnvelope(() => ({ valid: true })).prepareCommand(draft => { Reflect.set(draft, 'payload', {}); }).build(),
      createAggregatePlugin('bad').state(() => ({})).commandEnvelope(() => ({}), { parse: (): object => ({ id: 'bad' }) }).build(),
      createAggregatePlugin('bad').state(() => ({})).eventEnvelope(() => ({})).prepareEvent((() => ({})) as unknown as () => undefined).build()
    ];
    for (const plugin of plugins) {
      const host = base.withPlugins(plugin);
      expect(() => host.process(host.initialState, base.commandCreators.add({ amount: 1 }))).toThrow();
    }
  });

  test('observes async initializer, recipe and parser failures synchronously', async () => {
    const asyncObject = (): object => Promise.reject(new Error('async failure'));
    const asyncRecipe = asyncObject as unknown as () => undefined;
    const plugins = [
      createAggregatePlugin('bad').state(() => ({})).commandEnvelope(asyncObject).build(),
      createAggregatePlugin('bad').state(() => ({})).commandEnvelope(() => ({})).prepareCommand(asyncRecipe).build(),
      createAggregatePlugin('bad').state(() => ({})).eventEnvelope(asyncObject).build(),
      createAggregatePlugin('bad').state(() => ({})).eventEnvelope(() => ({})).prepareEvent(asyncRecipe).build(),
      createAggregatePlugin('bad').state(() => ({})).commandEnvelope(() => ({}), { parse: asyncObject }).build()
    ];
    for (const plugin of plugins) {
      const host = domain().withPlugins(plugin);
      expect(() => host.process(host.initialState, host.commandCreators.add({ amount: 1 }))).toThrow('synchronous');
    }
    await new Promise(resolve => setImmediate(resolve));
  });

  test('stale snapshot fails before preparation or command execution, including cached commands', () => {
    const initialize = jest.fn(() => ({ stamp: true }));
    const host = domain().withPlugins(createAggregatePlugin('own').state(() => ({})).commandEnvelope(initialize).build());
    const raw = host.commandCreators.add({ amount: 1 });
    expect(() => host.prepareCommand({ total: 0 } as typeof host.initialState, raw)).toThrow('migrate');
    expect(initialize).not.toHaveBeenCalled();
    const command = host.prepareCommand(host.initialState, raw);
    expect(() => host.process({ total: 0 } as typeof host.initialState, command)).toThrow('migrate');
    const eventOnly = domain().withPlugins(createAggregatePlugin('own').state(() => ({})).eventEnvelope(() => ({})).build());
    expect(() => eventOnly.process({ total: 0 } as typeof eventOnly.initialState, raw)).toThrow('migrate');
  });

  test('event core fields and intents survive preparation', () => {
    const rawEvent: Event<number> & { rawExtra: boolean } = { type: 'order.added.event', id: 'event-1', payload: 3,
      metadata: { domain: 'kept' }, headers: { custom: true }, rawExtra: true };
    const base = createAggregate('order', {}).events({ added() {} })
      .commands(() => ({ add: (() => ({ events: [rawEvent], intents: { notify: true } })) as unknown as () => Event[] })).build();
    const host = base.withPlugins(createAggregatePlugin('event').state(() => ({})).eventEnvelope(input => ({ sawExtra: input.rawExtra })).build());
    const command: Command<void, string> = { type: 'order.add.command', payload: undefined, id: 'command-1' };
    const events = host.process(host.initialState, command);
    expect(events[0]).toMatchObject({ id: 'event-1', payload: 3, headers: { custom: true }, metadata: { domain: 'kept', command: { id: 'command-1' } }, sawExtra: true });
    expect(events[0]).not.toHaveProperty('rawExtra');
    expect(Reflect.get(events, '__intents')).toEqual({ notify: true });
    expect(rawEvent.metadata).toEqual({ domain: 'kept' });
  });
});
