import { immerable } from 'immer';
import { stateContextSnapshot } from '../src/plugins/stateContextSnapshot';
import { envelopeSnapshot } from '../src/plugins/envelopeData';

test('state contexts detach cyclic data and Dates without freezing trusted functions', () => {
  const readLabel = () => 'label';
  const input = { date: new Date(123), values: [1], readLabel, self: undefined as unknown };
  input.self = input;
  const snapshot = stateContextSnapshot(input);
  expect(snapshot.self).toBe(snapshot);
  expect(snapshot.readLabel).toBe(readLabel);
  expect(snapshot.readLabel()).toBe('label');
  expect(Object.isFrozen(readLabel)).toBe(false);
  snapshot.date.setTime(456);
  expect(input.date.getTime()).toBe(123);
  expect(() => snapshot.values.push(2)).toThrow();
  expect(Object.isFrozen(input.values)).toBe(false);
  expect(() => envelopeSnapshot(input)).toThrow('not functions');
});

test('class readers and prototype getters use detached own data without invoking getters during capture', () => {
  let reads = 0;
  class Model {
    [immerable] = true;
    values = [1];
    read() { return this.values[0]; }
    get label() { reads++; return String(this.read()); }
    mutate() { this.values.push(2); }
  }
  const input = new Model();
  const snapshot = stateContextSnapshot(input);
  expect(reads).toBe(0);
  expect(snapshot).toBeInstanceOf(Model);
  expect(snapshot.read()).toBe(1);
  expect(snapshot.label).toBe('1');
  expect(() => snapshot.mutate()).toThrow();
  expect(input.values).toEqual([1]);
});

test('opaque native objects and own accessors fail without executing accessors', () => {
  expect(() => stateContextSnapshot({ handle: new WeakMap() })).toThrow('draftable');
  const read = jest.fn();
  const input = Object.defineProperty({}, 'value', { get: read });
  expect(() => stateContextSnapshot(input)).toThrow('accessors');
  expect(read).not.toHaveBeenCalled();
});
