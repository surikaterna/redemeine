import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import { createDemeineBridge } from '../src';
import { normalizeEnvelope } from '../src/normalizeEnvelope';

function definition() {
  const prepare = jest.fn();
  const source = createAggregate('boundary', {}).commands(() => ({ add: () => [] })).build();
  const built = source.withPlugins(createAggregatePlugin('host').commandEnvelope(() => {
    prepare();
    return {};
  }).build());
  return { built, prepare };
}

class LegacyCommand {
  id = 'command';
  type = 'boundary.add.command';
  aggregateId = 'one';
  payload = {};
}

test.each(['_sink', '_process'] as const)('%s accepts frozen class own data without mutating the caller', async entry => {
  const { built, prepare } = definition();
  const sink = jest.fn((command, aggregate) => aggregate._process(command));
  const live = new (createDemeineBridge(built))({ sink });
  live.id = 'one';
  const raw = Object.freeze(new LegacyCommand());
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  await live[entry](raw);
  expect(Object.getOwnPropertyDescriptors(raw)).toEqual(descriptors);
  expect(Object.hasOwn(raw, 'aggregateType')).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(1);
  if (entry === '_sink') {
    expect(sink.mock.calls[0]![0]).not.toBe(raw);
    expect(sink.mock.calls[0]![0]).toHaveProperty('aggregateType', 'boundary');
  }
});

test('queued class ingress leaves mutable raw keys and nested data untouched', async () => {
  const { built } = definition();
  const live = new (createDemeineBridge(built))();
  live.id = 'one';
  const raw = new LegacyCommand();
  const keys = Reflect.ownKeys(raw);
  const payload = raw.payload;
  await live._sink(raw);
  expect(Reflect.ownKeys(raw)).toEqual(keys);
  expect(raw.payload).toBe(payload);
  expect(Object.isFrozen(payload)).toBe(false);
});

test.each(['_sink', '_process'] as const)('%s rejects routing accessors before executing getters or setters', async entry => {
  for (const key of ['id', 'type', 'aggregateId', 'aggregateType']) {
    const { built, prepare } = definition();
    const sink = jest.fn();
    const live = new (createDemeineBridge(built))({ sink });
    live.id = 'one';
    const get = jest.fn(() => 'one');
    const set = jest.fn();
    const raw = Object.defineProperty(new LegacyCommand(), key, { get, set });
    await expect(live[entry](raw)).rejects.toThrow('accessors');
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  }
});

test('class ownership is taken in FIFO work after PromiseLike adoption', async () => {
  const { built } = definition();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sink = jest.fn(async (_command, aggregate) => { await gate; return aggregate; });
  const live = new (createDemeineBridge(built))({ sink });
  live.id = 'one';
  const first = live._sink(new LegacyCommand());
  const raw = new LegacyCommand();
  const then = jest.fn((resolve: (command: LegacyCommand) => unknown) => Promise.resolve(resolve(raw)));
  const second = live._sink({ then });
  await Promise.resolve();
  raw.aggregateId = 'wrong';
  release();
  await first;
  await expect(second).rejects.toThrow('command is missing data');
  expect(then).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(Object.hasOwn(raw, 'aggregateType')).toBe(false);
});

const decoratedDates = [
  ['string data', 'position', { value: { x: 1 }, enumerable: true }],
  ['hidden data', 'hidden', { value: { x: 1 } }],
  ['symbol data', Symbol('position'), { value: { x: 1 } }],
  ['hidden function', 'hidden', { value: () => 1 }],
  ['symbol function', Symbol('hidden'), { value: () => 1 }],
  ['accessor', 'hidden', { get: jest.fn() }],
  ['symbol accessor', Symbol('hidden'), { get: jest.fn() }],
] as const;

test.each(decoratedDates)('rejects Date %s directly and before the bridge sink', async (_label, key, descriptor) => {
  const date = Object.defineProperty(new Date(123), key, descriptor);
  expect(() => normalizeEnvelope({ date })).toThrow('Date own properties');
  const { built, prepare } = definition();
  const sink = jest.fn();
  const live = new (createDemeineBridge(built))({ sink });
  await expect(live._sink({ ...new LegacyCommand(), aggregateId: live.id, payload: { date } })).rejects.toThrow('Date own properties');
  expect(sink).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  if ('get' in descriptor) expect(descriptor.get).not.toHaveBeenCalled();
});

test('rejects Date subclass own class data before the bridge sink', async () => {
  class DateData extends Date { position = new LegacyCommand(); }
  const { built } = definition();
  const sink = jest.fn();
  const live = new (createDemeineBridge(built))({ sink });
  await expect(live._sink({ ...new LegacyCommand(), aggregateId: live.id, payload: { date: new DateData(123) } }))
    .rejects.toThrow('Date own properties');
  expect(sink).not.toHaveBeenCalled();
});

test('rejects Date subclass own data, but preserves undecorated instants and aliases without prototype getters', () => {
  class DateData extends Date { position = { x: 1 }; }
  expect(() => normalizeEnvelope({ date: new DateData(123) })).toThrow('Date own properties');
  const getter = jest.fn();
  class PlainDate extends Date {}
  Object.defineProperty(PlainDate.prototype, 'position', { get: getter });
  const date = new PlainDate(123);
  const raw = { command: new LegacyCommand(), a: date, b: date, invalid: new Date(NaN) };
  const normalized = normalizeEnvelope(raw);
  expect(normalized.a).toBe(normalized.b);
  expect(normalized.a).not.toBe(date);
  expect(normalized.a.getTime()).toBe(123);
  expect(normalized.invalid.getTime()).toBeNaN();
  expect(getter).not.toHaveBeenCalled();
});
