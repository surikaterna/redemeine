import { ReadonlyDeep } from './types/ReadonlyDeep';

const proxyCache = new WeakMap<object, object>();

export function createReadonlyDeepProxy<T>(value: T): ReadonlyDeep<T> {
  if (typeof value !== 'object' || value === null) {
    return value as ReadonlyDeep<T>;
  }

  const existing = proxyCache.get(value as object);
  if (existing) {
    return existing as ReadonlyDeep<T>;
  }

  const proxied = new Proxy(value as object, {
    get(target, prop, receiver) {
      const next = Reflect.get(target, prop, receiver);

      // Preserve Proxy invariants for frozen/non-configurable properties.
      if (Object.isFrozen(target)) {
        return next;
      }

      return createReadonlyDeepProxy(next);
    },
    set() {
      throw new Error('Cannot mutate properties directly');
    },
    deleteProperty() {
      throw new Error('Cannot mutate properties directly');
    },
    defineProperty() {
      throw new Error('Cannot mutate properties directly');
    },
    setPrototypeOf() {
      throw new Error('Cannot mutate properties directly');
    }
  });

  proxyCache.set(value as object, proxied);
  return proxied as ReadonlyDeep<T>;
}
