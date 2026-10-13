import { readonlySnapshot } from '../stateViews';

export function refuseMutation(): never {
  throw new Error('Cannot mutate properties directly');
}

export const readonlyTraps = {
  set: refuseMutation, deleteProperty: refuseMutation,
  defineProperty: refuseMutation, setPrototypeOf: refuseMutation
};

const mutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

export function readonlyArrayMember(items: readonly unknown[], property: PropertyKey): unknown {
  if (typeof property === 'string' && mutators.has(property)) return refuseMutation;
  if (property === 'first') return () => items[0];
  const value: unknown = Reflect.get(items, property);
  return typeof value === 'function' ? value.bind(items) : value;
}

export function readonlyValue(value: unknown): unknown {
  // Even reflection on a read view must never recover a writable alias to live state.
  return readonlySnapshot(value);
}
