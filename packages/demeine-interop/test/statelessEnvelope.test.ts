import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

function definition(clock: () => Date) {
  const source = createAggregate('counter', { id: '', _id: '', count: 0 })
    .events({ added(state, event: Event<{ amount: number }>) { state.count = (state.count ?? 0) + event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload) })).build();
  return source.withPlugins(createAggregatePluginFor(source, 'transport')
    .commandEnvelope(input => {
      const dateTime = input.dateTime ?? clock();
      if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) throw new Error('Invalid dateTime');
      return { dateTime, principal: input.principal };
    })
    .eventEnvelope((_, context) => ({ executionDateTime: context.command.dateTime.toISOString(), principal: context.command.principal }))
    .build());
}

test('stateless plugins prepare before the sink, survive Factory-style state replacement, and replay without a namespace', async () => {
  const clock = jest.fn(() => new Date('2026-10-19T00:00:00Z'));
  const built = definition(clock);
  const Bridge = createDemeineBridge(built);
  const live = new Bridge({ sink(command, aggregate) {
    expect(command).toHaveProperty('dateTime', new Date('2026-10-19T00:00:00Z'));
    Object.assign(command, { principal: { user: 'one' } });
    return aggregate._process(command);
  } });
  live.id = 'one';
  // Actual host initialization may omit domain defaults; no plugin namespace is needed.
  Reflect.set(live, '_state', { id: 'one', _id: 'one' });
  await live.add({ amount: 2 });
  expect(clock).toHaveBeenCalledTimes(1);
  expect(live._state).toEqual({ id: 'one', _id: 'one', count: 2 });
  const events = await live.getUncommittedEventsAsync();
  expect(events[0]).toMatchObject({ executionDateTime: '2026-10-19T00:00:00.000Z', principal: { user: 'one' }, aggregateId: 'one' });
  clock.mockImplementation(() => { throw new Error('replay restamped'); });
  const replay = new Bridge();
  replay.id = 'one';
  await replay._rehydrate(events, 1, { id: 'one', _id: 'one', count: 0 });
  expect(replay._state).toEqual(live._state);
  expect(replay.getUncommittedEvents()).toEqual([]);
});

test('invalid supplied dates fail before the external sink and event adapters cannot erase prepared extensions', async () => {
  const built = definition(() => new Date(0));
  const sink = jest.fn(async (_command, aggregate) => aggregate);
  const live = new (createDemeineBridge(built))({ sink });
  await expect(live._sink({ ...built.commandCreators.add({ amount: 1 }), aggregateId: live.id, dateTime: new Date(NaN) })).rejects.toThrow('Invalid dateTime');
  expect(sink).not.toHaveBeenCalled();
  const invalid = new (createDemeineBridge(built, { envelope(event) {
    Reflect.deleteProperty(event, 'executionDateTime');
    return event;
  } }))();
  await expect(invalid.add({ amount: 1 })).rejects.toThrow('Envelope must preserve');
  expect(invalid._state.count).toBe(0);
});

test('header-only capability detaches before the external sink and propagates without plugin state', async () => {
  const base = createAggregate('counter', { count: 0 })
    .events({ added(state) { state.count++; } })
    .commands(emit => ({ add: () => emit.added({}) })).build();
  const built = base.withPlugins(createAggregatePlugin('transport').eventEnvelope((_, ctx) => ({ headers: ctx.command.headers })).build());
  const headers = { principal: { user: 'one' } };
  const Bridge = createDemeineBridge(built);
  const live = new Bridge({ sink(command, aggregate) {
    expect(command.headers).toEqual(headers);
    expect(command.headers).not.toBe(headers);
    expect(command.aggregateType).toBe('counter');
    headers.principal.user = 'caller-mutated';
    return aggregate._process(command);
  } });
  await live._sink({ ...built.commandCreators.add(), payload: {}, aggregateId: live.id, headers });
  expect(live._state).toEqual({ count: 1 });
  const events = live.getUncommittedEvents();
  expect(events[0]!.headers).toEqual({ principal: { user: 'one' } });
  expect(events[0]).not.toHaveProperty('principal');
  expect(Object.isFrozen(headers.principal)).toBe(false);
  const replay = new Bridge();
  replay.id = live.id;
  await replay._rehydrate(events, 1, { count: 0 });
  expect(replay._state).toEqual(live._state);
});

test.each(['erase', 'replace', 'mutate'] as const)('adapter cannot %s plugin-prepared headers', async mode => {
  const base = createAggregate('protectedHeaders', { count: 0 })
    .events({ added(state) { state.count++; } })
    .commands(emit => ({ add: () => emit.added({}) })).build();
  const built = base.withPlugins(createAggregatePlugin('writer').eventEnvelope(() => ({ headers: { traceId: 'one' } })).build());
  const live = new (createDemeineBridge(built, { envelope(event) {
    if (mode === 'erase') Reflect.deleteProperty(event, 'headers');
    if (mode === 'replace') event.headers = { traceId: 'other' };
    if (mode === 'mutate') event.headers!.traceId = 'other';
    return event;
  } }))();
  await expect(live.add()).rejects.toThrow('Envelope must preserve');
  expect(live._state.count).toBe(0);
  expect(live.getUncommittedEvents()).toEqual([]);
});
