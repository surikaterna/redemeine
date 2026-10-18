import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge, type Command, type CommandSink, type CompatibleAggregate } from '../src';

const instant = '2026-10-16T10:00:00.000Z';
function definition(clock: () => Date, recipe = jest.fn()) {
  const source = createAggregate('counter', { count: 0 })
    .events({ added(state, event: Event<{ amount: number }>) { state.count += event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload),
      noop: () => [] })).build();
  const audit = createAggregatePlugin('audit').state(() => ({ dates: [] as string[], refs: [] as string[] }))
    .commandEnvelope(input => {
      const dateTime = input.dateTime === undefined ? clock() : input.dateTime;
      if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) throw new TypeError('Invalid dateTime');
      return { dateTime };
    }).prepareCommand(draft => { recipe(); draft.dateTime = new Date(draft.dateTime.getTime()); })
    .eventEnvelope((_, context) => {
      expect(context.event.id).toBeTruthy();
      expect(context.event.aggregateId).toBe(context.command.aggregateId);
      expect(context.event.correlationId).toBe(context.command.id);
      expect(context.event.metadata?.command).toMatchObject({ id: context.command.id, type: context.command.type });
      return { sourceCommandDateTime: new Date(context.command.dateTime.getTime()), auditRef: context.command.id! };
    }).onEvent((state, event) => {
      const date: unknown = Reflect.get(event, 'sourceCommandDateTime');
      const ref: unknown = Reflect.get(event, 'auditRef');
      if (date instanceof Date && typeof ref === 'string') { state.dates.push(date.toISOString()); state.refs.push(ref); }
    }).build();
  return source.withPlugins(audit);
}

test('adds command dateTime before the sink and preserves it through event replay', async () => {
  const clock = jest.fn(() => new Date(instant));
  const recipe = jest.fn();
  const built = definition(clock, recipe);
  const Bridge = createDemeineBridge(built);
  let commandId: string | undefined;
  const live = new Bridge({ sink(command, aggregate) {
    expect(Reflect.get(command, 'dateTime')).toBeInstanceOf(Date);
    expect(Reflect.get(command, 'dateTime')).toEqual(new Date(instant));
    commandId = command.id;
    return aggregate._process(command);
  } });
  await live.add({ amount: 2 });
  const events = await live.getUncommittedEventsAsync();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ sourceCommandDateTime: new Date(instant), auditRef: commandId,
    aggregateId: live.id, correlationId: commandId, metadata: { command: { id: commandId, type: built.types.commands.add } } });
  expect(clock).toHaveBeenCalledTimes(1);
  expect(recipe).toHaveBeenCalledTimes(1);
  clock.mockImplementation(() => { throw new Error('replay called clock'); });
  const replay = new Bridge();
  replay.id = live.id;
  await replay._rehydrate(events);
  expect(replay._state).toEqual(live._state);
  expect(replay._state).toEqual({ count: 2, audit: { dates: [instant], refs: [commandId] } });
  expect(replay.getUncommittedEvents()).toEqual([]);
});

test('preserves provided dates, rejects invalid dates before sink, and revalidates changed prepared dates', async () => {
  const clock = jest.fn(() => { throw new Error('unexpected clock'); });
  const built = definition(clock);
  let captured: Command | undefined;
  type Sink = CommandSink<typeof built.initialState>['sink'];
  const sink = jest.fn<ReturnType<Sink>, Parameters<Sink>>((command, aggregate) => {
    captured = command;
    return Promise.resolve(aggregate);
  });
  const live = new (createDemeineBridge(built))({ sink });
  const raw = { ...built.commandCreators.add({ amount: 1 }), aggregateId: live.id, dateTime: new Date(instant) };
  await live._sink(raw);
  expect(captured).toHaveProperty('dateTime', new Date(instant));
  expect(clock).not.toHaveBeenCalled();
  for (const dateTime of [new Date(NaN), null, '2026-10-16']) {
    await expect(live._sink({ ...raw, dateTime })).rejects.toThrow('Invalid dateTime');
  }
  expect(sink).toHaveBeenCalledTimes(1);
  const date: unknown = Reflect.get(captured!, 'dateTime');
  if (!(date instanceof Date)) throw new Error('missing prepared date');
  date.setTime(NaN);
  await expect(live._process(captured!)).rejects.toThrow('Invalid dateTime');
  expect(live._state.count).toBe(0);
});

test('direct process and custom handlers receive prepared commands without forcing sink processing', async () => {
  const clock = jest.fn(() => new Date(instant));
  const built = definition(clock);
  const handler = jest.fn((aggregate: CompatibleAggregate<typeof built.initialState>, command: Command) => {
    expect(Reflect.get(command, 'dateTime')).toEqual(new Date(instant));
    expect(command.aggregateId).toBe(aggregate.id);
    return aggregate;
  });
  const live = new (createDemeineBridge(built))(null, null, { handle: handler });
  await live._process({ ...built.commandCreators.add({ amount: 1 }), payload: { amount: 1 } });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(live._state.count).toBe(0);
  expect(clock).toHaveBeenCalledTimes(1);
});

test('direct raw process uses aggregate preparation and noops emit no events', async () => {
  const clock = jest.fn(() => new Date(instant));
  const built = definition(clock);
  const live = new (createDemeineBridge(built))();
  await live._process({ ...built.commandCreators.add({ amount: 4 }), payload: { amount: 4 } });
  expect(live._state.count).toBe(4);
  expect(live.getUncommittedEvents()[0]).toHaveProperty('sourceCommandDateTime', new Date(instant));
  live.clearUncommittedEvents();
  await live.noop();
  expect(live.getUncommittedEvents()).toEqual([]);
  expect(clock).toHaveBeenCalledTimes(2);
});

test('queued noops prepare in FIFO order and leave forwarding to the sink', async () => {
  const clock = jest.fn(() => new Date(instant));
  const built = definition(clock);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const live = new (createDemeineBridge(built))({ async sink(command, aggregate) {
    seen.push(command.type);
    if (seen.length === 1) await gate;
    return aggregate;
  } });
  const first = live.noop();
  const second = live.add({ amount: 3 });
  const settled = Promise.all([first, second]);
  void settled.catch(() => undefined);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(clock).toHaveBeenCalledTimes(1);
  }
  finally { release(); }
  await settled;
  expect(seen).toEqual([built.types.commands.noop, built.types.commands.add]);
  expect(clock).toHaveBeenCalledTimes(2);
  expect(live._state.count).toBe(0);
  expect(live.getUncommittedEvents()).toEqual([]);
});

test('post-sink headers and legacy transport status/refs remain available to conversion', async () => {
  const built = definition(() => new Date(instant));
  const refs = { command: 'store:1' };
  const converted = jest.fn();
  const live = new (createDemeineBridge(built, { envelope(event, command) {
    expect(command).toMatchObject({ status: 'saved', refs,
      headers: { commandSummary: 'safe', commandStoreRef: 'store:1' } });
    expect(event.metadata?.command).toMatchObject({ summary: 'safe', storeRef: 'store:1' });
    converted();
    return event;
  } }))({ sink(command, aggregate) {
    Object.assign(command, { status: 'saved', refs, headers: { commandSummary: 'safe', commandStoreRef: 'store:1' } });
    return aggregate._process(command);
  } });
  await live.add({ amount: 1 });
  expect(converted).toHaveBeenCalledTimes(1);
  expect(live._state.count).toBe(1);
});

test.each(['erase', 'change'])('rejects adapter extension %s before applying any events', async mode => {
  const built = definition(() => new Date(instant));
  const twoEvents = { ...built, process(state: typeof built.initialState, command: Parameters<typeof built.process>[1]) {
    const events = built.process(state, command);
    return [events[0]!, { ...events[0]!, id: 'sibling' }];
  } };
  let conversions = 0;
  const live = new (createDemeineBridge(twoEvents, { envelope(event) {
    if (++conversions === 1) return event;
    if (mode === 'erase') Reflect.deleteProperty(event, 'sourceCommandDateTime');
    else Reflect.set(event, 'sourceCommandDateTime', new Date(0));
    return event;
  } }))();
  const before = live._state;
  await expect(live.add({ amount: 2 })).rejects.toThrow('Envelope must preserve');
  expect(conversions).toBe(2);
  expect(live._state).toBe(before);
  expect(live._version).toBe(0);
  expect(live.getUncommittedEvents()).toEqual([]);
});
