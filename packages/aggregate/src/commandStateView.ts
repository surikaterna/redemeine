import { commandCollectionView } from './commandCollectionView';
import type { AggregateStateView } from './types/aggregateState';

function dateTime(value: object): number | undefined {
  try { return Date.prototype.getTime.call(value); }
  catch { return undefined; }
}

function denyMutation(): never {
  throw new TypeError('Cannot mutate command state');
}

function dateView(time: number): object {
  const data = Object.freeze(new Date(time));
  return new Proxy(data, {
    get(_target, property) {
      if (typeof property === 'string' && property.startsWith('set')) return undefined;
      if (!Object.hasOwn(Date.prototype, property)) return undefined;
      const member: unknown = Reflect.get(Date.prototype, property);
      // Bind only native readers, never model methods that could return the private Date.
      return typeof member === 'function' && property !== 'constructor' ? member.bind(data) : member;
    },
    set: denyMutation, defineProperty: denyMutation,
    deleteProperty: denyMutation, setPrototypeOf: denyMutation
  });
}

type Views = { seen: WeakMap<object, object>; sources: WeakMap<object, object> };

function unwrap(value: unknown, views: Views): unknown {
  return value !== null && typeof value === 'object' ? views.sources.get(value) ?? value : value;
}

function wrap(value: unknown, views: Views): unknown {
  if (value === null || typeof value !== 'object') return value;
  const cached = views.seen.get(value);
  if (cached) return cached;
  const time = dateTime(value);
  if (time !== undefined) {
    const date = dateView(time);
    views.seen.set(value, date);
    views.sources.set(date, value);
    return date;
  }
  if (value instanceof Map || value instanceof Set) {
    const collection = commandCollectionView(value, child => wrap(child, views), key => unwrap(key, views));
    views.seen.set(value, collection);
    views.sources.set(collection, value);
    return collection;
  }
  return objectView(value, views);
}

function objectView(value: object, views: Views): object {
  // A separate, empty facade permits lazy wrapping of even frozen own properties.
  // Proxying the source directly would require returning its mutable Date verbatim.
  const target: object = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
  const view: object = new Proxy(target, {
    get(_target, property, receiver) { return wrap(Reflect.get(value, property, receiver), views); },
    has(_target, property) { return Reflect.has(value, property); },
    ownKeys() { return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(_target, property) {
      if (Array.isArray(target) && property === 'length') return Reflect.getOwnPropertyDescriptor(target, property);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
      if (!descriptor) return undefined;
      return { configurable: true, enumerable: descriptor.enumerable === true,
        get: () => wrap(Reflect.get(value, property, view), views) };
    },
    set: denyMutation, defineProperty: denyMutation, deleteProperty: denyMutation,
    setPrototypeOf: denyMutation, preventExtensions: denyMutation
  });
  views.seen.set(value, view);
  views.sources.set(view, value);
  return view;
}

export function commandStateView<T>(value: T): AggregateStateView<T> {
  // The sole structural assertion: recursive lazy wrapping preserves model shape,
  // while Date facades deliberately remove setters from the public view.
  return wrap(value, { seen: new WeakMap(), sources: new WeakMap() }) as AggregateStateView<T>;
}
