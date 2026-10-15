function dateTime(value: object): number | undefined {
  try { return Date.prototype.getTime.call(value); }
  catch { return undefined; }
}

function isPlainPrototype(prototype: object | null): boolean {
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const ctor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!ctor || !('value' in ctor) || typeof ctor.value !== 'function') return false;
  const ownPrototype = Object.getOwnPropertyDescriptor(ctor.value, 'prototype');
  return ownPrototype?.value === prototype && Function.prototype.toString.call(ctor.value) === Function.prototype.toString.call(Object);
}

// Snapshots deliberately detach Dates: Object.freeze alone cannot disable Date setters.
export function cloneEnvelopeData<T>(value: T, seen = new Map<object, object>()): T {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw new TypeError('Envelope snapshots require data, not functions');
    return value;
  }
  const cached = seen.get(value);
  if (cached) return cached as T;
  const time = dateTime(value);
  if (time !== undefined) {
    const result = new Date(time);
    seen.set(value, result);
    return result as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && !isPlainPrototype(prototype)) {
    throw new TypeError('Envelope snapshots require plain objects, arrays or Dates');
  }
  const result = Array.isArray(value) ? new Array(value.length) : Object.create(prototype === null ? null : Object.prototype) as object;
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new TypeError('Envelope snapshots do not support accessors');
    Object.defineProperty(result, key, {
      value: cloneEnvelopeData(descriptor.value, seen), enumerable: descriptor.enumerable === true, writable: true, configurable: true
    });
  }
  return result as T;
}

function freezeSnapshot(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeSnapshot(Reflect.get(value, key), seen);
  Object.freeze(value);
}

export function envelopeSnapshot<T>(value: T): T {
  const result = cloneEnvelopeData(value);
  freezeSnapshot(result);
  return result;
}

export function sameEnvelopeData(left: unknown, right: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftTime = dateTime(left);
  const rightTime = dateTime(right);
  if (leftTime !== undefined || rightTime !== undefined) return leftTime !== undefined && rightTime !== undefined && Object.is(leftTime, rightTime);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (!Array.isArray(left) && leftPrototype !== rightPrototype && !(leftPrototype !== null && rightPrototype !== null && isPlainPrototype(leftPrototype) && isPlainPrototype(rightPrototype))) return false;
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Reflect.ownKeys(right).length) return false;
  return keys.every(key => {
    const a = Object.getOwnPropertyDescriptor(left, key)!;
    const b = Object.getOwnPropertyDescriptor(right, key);
    return b !== undefined && 'value' in a && 'value' in b && sameEnvelopeData(a.value, b.value, seen);
  });
}
