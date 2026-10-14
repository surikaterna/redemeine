export function requireSync<T>(value: T, label: string): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    // Observe already-started work without accepting async evolution. A fresh
    // promise also turns throwing then getters/methods into observed rejections.
    void new Promise<unknown>(resolve => resolve(value)).catch(() => undefined);
    throw new TypeError(`${label} must be synchronous`);
  }
  return value;
}

export function validateHandler(handler: unknown, label: string): void {
  if (handler == null) return;
  if (typeof handler !== 'object' || !('handle' in handler) || typeof handler.handle !== 'function') {
    throw new TypeError(`${label} must expose handle()`);
  }
  if (label === 'eventHandler' && handler.handle.constructor.name === 'AsyncFunction') {
    throw new TypeError('eventHandler must be synchronous');
  }
}

export function rejectLifecycle(builder: { hooks?: object; plugins?: readonly unknown[] }): void {
  if (Object.values(builder.hooks ?? {}).some(value => value != null) || builder.plugins?.length) {
    throw new Error('demeine-interop does not support lifecycle hooks or plugins');
  }
}

/** Capture metadata invariants before user conversion, including in-place mutations. */
export function preserveValue(value: unknown, seen = new WeakMap<object, (next: unknown) => boolean>()): (next: unknown) => boolean {
  if (!value || typeof value !== 'object') return next => Object.is(value, next);
  const known = seen.get(value);
  if (known) return next => next === value;
  if (value instanceof Date) {
    const time = value.getTime();
    return next => next instanceof Date && next.getTime() === time;
  }
  const prototype = Object.getPrototypeOf(value);
  const arrayLength = Array.isArray(value) ? value.length : undefined;
  if (prototype !== Object.prototype && prototype !== null && arrayLength === undefined) {
    return next => Object.is(value, next);
  }
  const checks: [string, (next: unknown) => boolean][] = [];
  const check = (next: unknown): boolean => !!next && typeof next === 'object'
    && (arrayLength === undefined || (Array.isArray(next) && next.length === arrayLength))
    && checks.every(([key, matches]) => key in next && matches(Reflect.get(next, key)));
  seen.set(value, check);
  for (const [key, entry] of Object.entries(value)) checks.push([key, preserveValue(entry, seen)]);
  return check;
}
