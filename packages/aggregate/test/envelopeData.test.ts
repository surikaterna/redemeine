import { runInNewContext } from 'node:vm';
import { cloneEnvelopeData, envelopeSnapshot, sameEnvelopeData } from '../src/plugins/envelopeData';

test('structuredClone host-realm data is portable inside Jest', () => {
  const input = structuredClone({ nested: { count: 1 }, date: new Date(123), items: [1] });
  expect(Object.getPrototypeOf(input)).not.toBe(Object.prototype);
  const copy = cloneEnvelopeData(input);
  expect(copy).toEqual({ nested: { count: 1 }, date: new Date(123), items: [1] });
  expect(copy).not.toBe(input);
  expect(sameEnvelopeData(input, copy)).toBe(true);
});

test('vm records, arrays and branded Dates clone with sparse holes and null prototypes intact', () => {
  const input = runInNewContext('({ date: new Date(123), invalid: new Date(NaN), items: new Array(3), record: Object.assign(Object.create(null), { count: 1 }) })');
  const copy = cloneEnvelopeData(input);
  expect(copy.date).toBeInstanceOf(Date);
  expect(copy.date.getTime()).toBe(123);
  expect(Number.isNaN(copy.invalid.getTime())).toBe(true);
  expect(copy.items).toHaveLength(3);
  expect(0 in copy.items).toBe(false);
  expect(Object.getPrototypeOf(copy.record)).toBeNull();
  expect(sameEnvelopeData(input, copy)).toBe(true);
  expect(sameEnvelopeData(copy.record, { count: 1 })).toBe(false);
  expect(sameEnvelopeData([], {})).toBe(false);
});

test.each([
  new (class Payload { count = 1; })(),
  runInNewContext('new (class Payload { count = 1; })()'),
  Object.create({ count: 1 }),
  Object.create(Object.assign(Object.create(null), { constructor: Object })),
  new Map(), new Set(), /data/, new Uint8Array(1),
])('rejects unsupported prototypes rather than treating any object as data: %p', input => {
  expect(() => cloneEnvelopeData(input)).toThrow('plain objects, arrays or Dates');
});

test('a Date tag cannot spoof the Date brand', () => {
  const input = { [Symbol.toStringTag]: 'Date' };
  const copy = cloneEnvelopeData(input);
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  expect(copy[Symbol.toStringTag]).toBe('Date');
  expect(sameEnvelopeData(input, copy)).toBe(true);
  expect(copy).not.toBeInstanceOf(Date);
});

test('does not invoke own or prototype accessors while rejecting unsupported data', () => {
  const getter = jest.fn(() => 1);
  const input = Object.defineProperty({}, 'count', { get: getter });
  const prototype = Object.defineProperty(Object.create(null), 'constructor', { get: getter });
  expect(() => cloneEnvelopeData(input)).toThrow('accessors');
  expect(() => cloneEnvelopeData(Object.create(prototype))).toThrow('plain objects');
  expect(() => cloneEnvelopeData({ callback() {} })).toThrow('functions');
  expect(getter).not.toHaveBeenCalled();
});

test('snapshots and cached comparisons detach Dates, preserve aliases and detect Date mutation', () => {
  const date = runInNewContext('new Date(123)') as Date;
  const input = { date, alias: date, nested: { count: 1 } };
  const snapshot = envelopeSnapshot(input);
  expect(snapshot.date).not.toBe(date);
  expect(snapshot.alias).toBe(snapshot.date);
  expect(Object.isFrozen(snapshot.nested)).toBe(true);
  expect(sameEnvelopeData(input, snapshot)).toBe(true);
  date.setTime(456);
  expect(snapshot.date.getTime()).toBe(123);
  expect(sameEnvelopeData(input, snapshot)).toBe(false);
  snapshot.date.setTime(789);
  expect(date.getTime()).toBe(456);
});

test.each([() => ({ x: 1 }), () => new Date(123)])('graph comparisons detect alias splitting and collapsing: %p', make => {
  const shared = make();
  const aliased = { a: shared, b: shared };
  const separate = { a: make(), b: make() };
  expect(sameEnvelopeData(aliased, separate)).toBe(false);
  expect(sameEnvelopeData(separate, aliased)).toBe(false);
  expect(sameEnvelopeData(aliased, cloneEnvelopeData(aliased))).toBe(true);
});

test('cyclic graphs preserve correspondence and sparse array shape', () => {
  const graph: { self?: unknown; items: unknown[] } = { items: new Array(3) };
  graph.self = graph;
  graph.items[1] = graph;
  expect(sameEnvelopeData(graph, cloneEnvelopeData(graph))).toBe(true);
  const changed = cloneEnvelopeData(graph);
  changed.items[0] = undefined;
  expect(sameEnvelopeData(graph, changed)).toBe(false);
});
