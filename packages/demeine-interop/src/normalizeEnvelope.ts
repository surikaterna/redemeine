function dateTime(value: object): number | undefined {
  try { return Date.prototype.getTime.call(value); }
  catch { return undefined; }
}

function isClassData(value: object): boolean {
  let prototype = Object.getPrototypeOf(value);
  const custom = prototype !== null && prototype !== Object.prototype;
  while (prototype !== null) {
    if (Object.hasOwn(prototype, Symbol.toStringTag)) {
      throw new TypeError('Envelope normalization does not support tagged native or opaque objects');
    }
    const ctor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (ctor && 'value' in ctor && typeof ctor.value === 'function'
      && Function.prototype.toString.call(ctor.value) !== Function.prototype.toString.call(Object)
      && Function.prototype.toString.call(ctor.value).includes('[native code]')) {
      throw new TypeError('Envelope normalization requires objects, arrays or Dates, not native containers');
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return custom;
}

// Preserve all own data, including symbols and non-enumerables; never invoke getters.
// Plain prepared commands retain identity so the Aggregate preparation cache remains authoritative.
export function normalizeEnvelope<T extends object>(input: T): T {
  const seen = new Map<object, object>();
  let changed = false;
  function visit(value: unknown): unknown {
    if (typeof value === 'function') throw new TypeError('Envelope normalization requires data, not functions');
    if (value === null || typeof value !== 'object') return value;
    const cached = seen.get(value);
    if (cached) return cached;
    const time = dateTime(value);
    if (time !== undefined) {
      if (Reflect.ownKeys(value).length) throw new TypeError('Envelope normalization does not support Date own properties');
      if (Object.getPrototypeOf(value) !== Date.prototype) changed = true;
      const date = new Date(time);
      seen.set(value, date);
      return date;
    }
    if (!Array.isArray(value) && isClassData(value)) changed = true;
    const result = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new TypeError('Envelope normalization does not support accessors');
      Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: descriptor.enumerable === true, writable: true, configurable: true });
    }
    return result;
  }
  const normalized = visit(input);
  return changed ? normalized as T : input;
}
