type Pairs = { forward: Map<object, object>; reverse: Map<object, object> };
type Match = (next: unknown, pairs: Pairs) => boolean;

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const ctor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!ctor || !('value' in ctor) || typeof ctor.value !== 'function') return false;
  return Object.getOwnPropertyDescriptor(ctor.value, 'prototype')?.value === prototype
    && Function.prototype.toString.call(ctor.value) === Function.prototype.toString.call(Object);
}

function dateTime(value: object): number | undefined {
  try { return Date.prototype.getTime.call(value); }
  catch { return undefined; }
}

function capture(value: unknown, seen: Map<object, Match>): Match {
  if (!value || typeof value !== 'object') return next => Object.is(value, next);
  const known = seen.get(value);
  if (known) return known;
  const time = dateTime(value);
  if (time === undefined && !Array.isArray(value) && !plain(value)) {
    throw new TypeError('Prepared envelopes require plain objects, arrays or Dates');
  }
  const token = {};
  const isDate = time !== undefined;
  const array = Array.isArray(value);
  const checks: [PropertyKey, Match][] = [];
  const match: Match = (next, pairs) => {
    if (!next || typeof next !== 'object') return false;
    if (pairs.forward.has(token)) return pairs.forward.get(token) === next;
    if (pairs.reverse.has(next)) return false;
    pairs.forward.set(token, next);
    pairs.reverse.set(next, token);
    if (isDate) return Object.is(dateTime(next), time);
    if (Array.isArray(next) !== array || (!array && !plain(next))) return false;
    return Reflect.ownKeys(next).length === checks.length && checks.every(([key, check]) => {
      const descriptor = Object.getOwnPropertyDescriptor(next, key);
      return descriptor !== undefined && 'value' in descriptor && check(descriptor.value, pairs);
    });
  };
  seen.set(value, match);
  if (isDate) return match;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new TypeError('Prepared envelopes do not support accessors');
    checks.push([key, capture(descriptor.value, seen)]);
  }
  return match;
}

// Capture values, not live references: an adapter may mutate its input in place.
export function preservePreparedValue(value: unknown): (next: unknown) => boolean {
  const match = capture(value, new Map());
  return next => match(next, { forward: new Map(), reverse: new Map() });
}
