import { isDraftable } from 'immer';

function dateTime(value: object): number | undefined {
  try { return Date.prototype.getTime.call(value); }
  catch { return undefined; }
}

// Unlike envelope data, aggregate models may carry trusted functions and immerable prototypes.
// Only own data is detached; private fields, accessors and opaque native internals are unsupported.
export function stateContextSnapshot<T>(value: T, seen = new Map<object, object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached as T;
  let result: object;
  const time = dateTime(value);
  if (time !== undefined) result = new Date(time);
  else {
    if (!isDraftable(value) || value instanceof Map || value instanceof Set) {
      throw new TypeError('Plugin state contexts require draftable objects, arrays or Dates');
    }
    result = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
  }
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new TypeError('Plugin state contexts do not support own accessors');
    Object.defineProperty(result, key, {
      value: stateContextSnapshot(descriptor.value, seen), enumerable: descriptor.enumerable === true,
      writable: false, configurable: false
    });
  }
  return Object.freeze(result) as T;
}
