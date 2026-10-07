import { Aggregate } from 'demeine';
import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { DefaultCommandHandler } from 'demeine/lib/aggregate/DefaultCommandHandler';
import { DefaultEventHandler } from 'demeine/lib/aggregate/DefaultEventHandler';
import type { CommandSink, CommandHandler, EventHandler } from 'demeine';
import { createDemeineBridge } from '../src';
import { definition, fixture } from './fixture';

test('real base owns UUID, independent state, live identity/type/state, sink and queue', async () => {
  const { Bridge, process, apply } = fixture();
  const sink: CommandSink = { sink: jest.fn((command, aggregate) => aggregate._process(command)) };
  const aggregate = new Bridge(sink);
  const other = new Bridge();
  expect(aggregate).toBeInstanceOf(Aggregate);
  expect(aggregate.id).not.toBe(other.id);
  expect(aggregate._state).not.toBe(other._state);
  aggregate.id = 'late';
  aggregate.type = 'LiveCounter';
  aggregate._state = { count: 10, items: ['replacement'] };
  await aggregate.add(3);
  expect(aggregate._commandSink).toBe(sink);
  expect(sink.sink).toHaveBeenCalledTimes(1);
  expect(process).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(process.mock.calls[0]![1]).toMatchObject({ aggregateId: 'late', aggregateType: 'LiveCounter' });
  expect(aggregate._state).toEqual({ count: 13, items: ['replacement'] });
  expect(other._state.count).toBe(0);
  expect(aggregate.getVersion()).toBe(1);
  expect(await aggregate.getUncommittedEventsAsync()).toHaveLength(1);
});

test.each([[false, false], [true, false], [false, true], [true, true]])(
  'handlers selected independently: commands=%s events=%s', async (commands, events) => {
    const { Bridge, process, apply } = fixture();
    const commandHandler = new DefaultCommandHandler();
    const eventHandler = new DefaultEventHandler();
    const commandSpy = jest.spyOn(commandHandler, 'handle');
    const eventSpy = jest.spyOn(eventHandler, 'handle');
    const aggregate = new Bridge(undefined, events ? eventHandler : undefined, commands ? commandHandler : undefined);
    await aggregate.add(2);
    expect(process).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(commandSpy).toHaveBeenCalledTimes(commands ? 1 : 0);
    expect(eventSpy).toHaveBeenCalledTimes(events ? 1 : 0);
    if (commands) expect(commandSpy.mock.contexts[0]).toBe(commandHandler);
    if (events) expect(eventSpy.mock.contexts[0]).toBe(eventHandler);
  },
);

test('supplied command exceptions/rejections execute once and never fall back', async () => {
  for (const asynchronous of [false, true]) {
    const { Bridge, process, apply } = fixture();
    const error = new Error('custom failure');
    const handle = jest.fn(() => { if (asynchronous) return Promise.reject(error); throw error; });
    // demeine declares a synchronous return, although _process assimilates promises.
    const handler = { handle } as unknown as CommandHandler;
    const aggregate = new Bridge(null, null, handler);
    await expect(aggregate.add(1)).rejects.toThrow(error);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(process).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  }
});

test('supplied event handler is a synchronous full override, including failures', async () => {
  const { Bridge, apply } = fixture();
  const events = { handle: jest.fn(() => { throw new Error('event failed'); }) };
  const aggregate = new Bridge(undefined, events);
  await expect(aggregate.add(1)).rejects.toThrow('event failed');
  expect(events.handle).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(aggregate.getVersion()).toBe(0);
  expect(() => new Bridge(null, { handle: async () => {} })).toThrow('synchronous');
  const thenable: EventHandler = { handle: () => Promise.resolve() };
  await expect(new Bridge(null, thenable).add(1)).rejects.toThrow('synchronous');
});

test('malformed services and ambiguous/reserved generated names fail fast', () => {
  const { Bridge } = fixture();
  // Runtime callers can be untyped; none of these values mean "absent".
  for (const malformed of [false, {}, { handle: 1 }]) {
    expect(() => Reflect.construct(Bridge, [null, malformed])).toThrow('handle');
    expect(() => Reflect.construct(Bridge, [null, null, malformed])).toThrow('handle');
  }
  for (const commands of [{ add: '$stream.delete.command' }, { add: 'x.add.command', duplicate: 'y.add.command' }]) {
    const built = definition();
    expect(() => createDemeineBridge({ ...built, types: { ...built.types, commands } }, { AggregateBase: Aggregate })).toThrow('collision');
  }
  const built = definition();
  expect(() => createDemeineBridge({ ...built, types: { ...built.types, commands: { delete: 'x.remove.command' } } }, { AggregateBase: Aggregate })).toThrow('collision');
});

test.each(['then', '_sink', '_process', '_apply', '_rehydrate', 'delete', 'getUncommittedEventsAsync', '_commandQueue'])(
  'real builder shortcut %s cannot replace the promise/lifecycle boundary', name => {
    const executed = jest.fn();
    const built = createAggregate('counter', { count: 0 })
      .events({ added: (state, _event: Event<Record<string, never>>) => { state.count++; } })
      .commands(emit => ({ [name]: { pack: () => ({}), handler: () => { executed(); return emit.added({}); } } }))
      .build();
    expect(() => createDemeineBridge(built, { AggregateBase: Aggregate }))
      .toThrow(name === 'then' ? 'Legacy method collision: then' : 'Legacy method collision:');
    expect(executed).not.toHaveBeenCalled();
  },
);

test('promised commands, drain, replay and snapshot semantics remain inherited', async () => {
  const { Bridge, process } = fixture();
  const aggregate = new Bridge();
  const first = aggregate._sink(Promise.resolve({ type: 'counter.add.command', aggregateId: aggregate.id, payload: { amount: 2 } }));
  const second = aggregate.add(3);
  const drained = aggregate.getUncommittedEventsAsync();
  await Promise.all([first, second]);
  const events = await drained;
  expect(events).toHaveLength(2);
  expect(aggregate._state.count).toBe(5);
  const replay = new Bridge();
  replay.id = aggregate.id;
  await replay._rehydrate(events, 7, { count: 10, items: [] });
  expect(replay._state.count).toBe(15);
  expect(replay._getSnapshot()).toBe(replay._state);
  expect(replay.getVersion()).toBe(7);
  expect(replay.getUncommittedEvents()).toEqual([]);
  expect(process).toHaveBeenCalledTimes(2);
  await expect(aggregate._sink({ type: 'counter.add.command', aggregateId: 'wrong', payload: {} })).rejects.toThrow('missing data');
  await expect(aggregate._sink({ type: 'counter.unknown.command', aggregateId: aggregate.id, payload: {} })).rejects.toThrow('Unknown command');
});

test('opaque successful handlers are full overrides with no generated domain work', async () => {
  const { Bridge, process, apply } = fixture();
  const commands: CommandHandler = { handle: jest.fn(aggregate => aggregate) };
  const aggregate = new Bridge(null, null, commands);
  await aggregate.add(1);
  expect(commands.handle).toHaveBeenCalledTimes(1);
  expect(process).not.toHaveBeenCalled();
  const events: EventHandler = { handle: jest.fn() };
  const other = new Bridge(null, events);
  await other.add(1);
  expect(events.handle).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(other._state.count).toBe(0);
  expect(other.getVersion()).toBe(1);
});

test('legacy nested/snake-case dispatch names work with actual Default handlers', async () => {
  const built = definition();
  const remapped = {
    ...built,
    types: { commands: { add: 'legacy.counter.add.command' }, events: { added: 'legacy.counter_added.event' } },
    commandCreators: { add: (amount: number) => ({ type: 'legacy.counter.add.command', payload: { amount } }) },
    process: () => [{ type: 'legacy.counter_added.event' as const, payload: { amount: 3 } }],
    apply: () => ({ count: 3, items: [] }),
  };
  const Bridge = createDemeineBridge(remapped, { AggregateBase: Aggregate });
  const aggregate = new Bridge(null, new DefaultEventHandler(), new DefaultCommandHandler());
  await aggregate.add(3);
  expect(aggregate._state.count).toBe(3);
  expect(aggregate.getVersion()).toBe(1);
});
