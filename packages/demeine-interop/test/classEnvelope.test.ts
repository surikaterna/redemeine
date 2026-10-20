import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';
import { normalizeEnvelope } from '../src/normalizeEnvelope';

class PositionData {
  constructor(public x: number) {}
  label() { return String(this.x); }
}

function definition() {
  const payload = { amount: 2, nested: { value: 3 } };
  const headers = { principal: { user: 'host' } };
  const command = jest.fn();
  const event = jest.fn();
  const source = createAggregate('counter', { count: 0 })
    .events({ added(state, input: Event<typeof payload>) { state.count += input.payload.amount; } })
    .commands(emit => ({ add: () => [emit.added(payload), emit.added(payload)] })).build();
  const built = source.withPlugins(createAggregatePlugin('host').propagateCommandHeadersToEvents()
    .commandEnvelope(input => {
      command();
      const position = input.position ?? { x: 0 };
      expect(Object.getPrototypeOf(position)).toBe(Object.prototype);
      return { position };
    })
    .eventEnvelope((_, context) => {
      event();
      return { position: context.command.position };
    }).build());
  return { built, command, event, payload, headers };
}

function expectIsolation(events: Event[], payload: ReturnType<typeof definition>['payload'], headers: ReturnType<typeof definition>['headers']) {
  expect(events[0]!.headers).not.toBe(headers);
  expect(events[0]!.payload).not.toBe(payload);
  expect(events[0]!.payload).not.toBe(events[1]!.payload);
  expect(Object.isFrozen(headers.principal)).toBe(false);
  expect(Object.isFrozen(payload.nested)).toBe(false);
  payload.nested.value = 9;
  headers.principal.user = 'changed';
  expect(events[0]!.payload).toMatchObject({ nested: { value: 3 } });
  expect(events[0]!.headers).toEqual({ principal: { user: 'host' } });
}

test('normalizes command classes and post-sink PositionData with headers, transport and lightweight metadata intact', async () => {
  const { built, command, event, headers, payload } = definition();
  const position = new PositionData(1);
  class LegacyCommand {
    id = 'command-one';
    type = built.types.commands.add;
    aggregateId = 'one';
    payload = {};
    headers = headers;
    position = position;
    status = 'created';
    refs = { store: 'one' };
  }
  const raw = new LegacyCommand();
  const live = new (createDemeineBridge(built))({ sink(prepared, aggregate) {
    if (prepared.type === '$stream.delete.command') return aggregate._process(prepared);
    expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype);
    expect(prepared).toMatchObject({ position: { x: 1 }, status: 'created', refs: raw.refs });
    Object.assign(prepared, { position: new PositionData(7), status: 'saved' });
    return aggregate._process(prepared);
  } });
  live.id = 'one';
  await live._sink(raw);
  // Existing transport fields are reattached after Aggregate caches its projection.
  expect(command).toHaveBeenCalledTimes(4);
  expect(event).toHaveBeenCalledTimes(2);
  expect(raw.position).toBe(position);
  expect(raw.position.x).toBe(1);
  expect(raw.headers).toBe(headers);
  const events = live.getUncommittedEvents();
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ position: { x: 7 }, headers, aggregateId: 'one', correlationId: raw.id,
    metadata: { command: { id: raw.id, type: raw.type } } });
  expect(events[0]!.metadata!.command).toEqual({ id: raw.id, type: raw.type });
  expectIsolation(events, payload, headers);
  await live._rehydrate(events, 1, { count: 0 });
  expect(command).toHaveBeenCalledTimes(4);
  expect(event).toHaveBeenCalledTimes(2);
  await live.delete();
  expect(command).toHaveBeenCalledTimes(4);
});

test('unchanged prepared identity suppresses repeat callbacks, including repeated process', async () => {
  const { built, command } = definition();
  const live = new (createDemeineBridge(built))({ async sink(prepared, aggregate) {
    await aggregate._process(prepared);
    await aggregate._process(prepared);
    return aggregate;
  } });
  await live.add();
  expect(command).toHaveBeenCalledTimes(1);
});

test('normalization retains aliases, cycles, dates, symbols and non-enumerable data', () => {
  const symbol = Symbol('data');
  const position = new PositionData(1);
  const raw = { a: position, b: position, date: new Date(NaN), [symbol]: position, self: {} };
  raw.self = raw;
  Object.defineProperty(position, 'hidden', { value: { value: 2 } });
  const normalized = normalizeEnvelope(raw);
  expect(normalized).not.toBe(raw);
  expect(normalized.a).toBe(normalized.b);
  expect(normalized[symbol]).toBe(normalized.a);
  expect(normalized.self).toBe(normalized);
  expect(Reflect.get(normalized.a, 'hidden')).toEqual({ value: 2 });
  expect(Object.getOwnPropertyDescriptor(normalized.a, 'hidden')!.enumerable).toBe(false);
  expect(normalized.date).not.toBe(raw.date);
  expect(normalized.date.getTime()).toBeNaN();
});

test.each([new Map(), new Set(), /pattern/, new Uint8Array(1), new URL('https://example.com'), Promise.resolve(1), () => 1])
('rejects unsupported data before calling the sink', async unsupported => {
  const { built, command } = definition();
  const sink = jest.fn();
  const live = new (createDemeineBridge(built))({ sink });
  await expect(live._sink({ ...built.commandCreators.add(), payload: {}, position: unsupported })).rejects.toThrow();
  expect(sink).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

test('rejects own accessors and hidden/symbol functions without invoking or dropping them', () => {
  const getter = jest.fn();
  const accessor = Object.defineProperty(new PositionData(1), 'value', { get: getter });
  expect(() => normalizeEnvelope({ accessor })).toThrow('accessors');
  expect(getter).not.toHaveBeenCalled();
  for (const key of ['hidden', Symbol('hidden')]) {
    const value = Object.defineProperty(new PositionData(1), key, { value: () => 1 });
    expect(() => normalizeEnvelope({ value })).toThrow('functions');
  }
});

test('native Aggregate remains strict while inactive bridge keeps class references', async () => {
  const { built } = definition();
  expect(() => built.prepareCommand(built.initialState, { ...built.commandCreators.add(), payload: {}, position: new PositionData(1) })).toThrow('plain');
  const inactive = createAggregate('inactive', {}).commands(() => ({ add: () => [] })).build();
  const position = new PositionData(1);
  const sink = jest.fn(async (_command, aggregate) => aggregate);
  const live = new (createDemeineBridge(inactive))({ sink });
  const raw = { ...inactive.commandCreators.add(), aggregateId: live.id, payload: {}, position };
  await live._sink(raw);
  expect(sink.mock.calls[0]![0]).toBe(raw);
  expect(raw.position).toBe(position);
});

test('native preparation detaches host event payloads and headers without freezing their sources', () => {
  const { built, headers, payload } = definition();
  const events = built.process(built.initialState, { ...built.commandCreators.add(), headers });
  expect(events[0]!.payload).not.toBe(payload);
  expect(events[0]!.payload).not.toBe(events[1]!.payload);
  expect(events[0]!.headers).not.toBe(headers);
  expect(Object.isFrozen(payload.nested)).toBe(false);
  expect(Object.isFrozen(headers.principal)).toBe(false);
});

test('plain legacy status/refs already invalidate the Aggregate cache on each preparation', async () => {
  const { built, command } = definition();
  const live = new (createDemeineBridge(built))();
  await live._sink({ ...built.commandCreators.add(), aggregateId: live.id, payload: {}, status: 'saved', refs: {} });
  expect(command).toHaveBeenCalledTimes(4);
});

test('post-sink class changes reprepare once when no transport extras invalidate the cache', async () => {
  const { built, command } = definition();
  const live = new (createDemeineBridge(built))({ sink(prepared, aggregate) {
    Object.assign(prepared, { position: new PositionData(8) });
    return aggregate._process(prepared);
  } });
  await live.add();
  expect(command).toHaveBeenCalledTimes(2);
  expect(live.getUncommittedEvents()[0]).toMatchObject({ position: { x: 8 } });
});

test('header-only capability activates class normalization without envelope callbacks', async () => {
  const source = createAggregate('headers', {}).commands(() => ({ add: () => [] })).build();
  const built = source.withPlugins(createAggregatePlugin('headers').propagateCommandHeadersToEvents().build());
  const headers = { position: new PositionData(1) };
  const live = new (createDemeineBridge(built))({ sink(prepared, aggregate) {
    expect(Object.getPrototypeOf(prepared.headers!.position)).toBe(Object.prototype);
    expect(prepared.headers).not.toBe(headers);
    return aggregate._process(prepared);
  } });
  await live._sink({ ...built.commandCreators.add(), aggregateId: live.id, payload: {}, headers });
  expect(headers.position).toBeInstanceOf(PositionData);
  expect(Object.isFrozen(headers.position)).toBe(false);
});
