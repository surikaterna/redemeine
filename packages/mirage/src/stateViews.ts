import type { AggregateStateView as ReadonlyDeep } from '@redemeine/aggregate';
import { dateTime, readonlyDate } from './readonlyDate';
import { collectionKind, collectionView } from './stateCollectionView';

const snapshotData = new WeakMap<object, object>();
type Views = WeakMap<object, object>;

function denyMutation(): never {
  throw new TypeError('Cannot mutate properties directly');
}

function unwrap(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? snapshotData.get(value) ?? value : value;
}

function wrap(value: unknown, seen: Views, root = false): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (snapshotData.has(value)) return value;
  const cached = seen.get(value);
  if (cached) return cached;
  const time = dateTime(value);
  const kind = time === undefined ? collectionKind(value) : undefined;
  const view = time !== undefined ? readonlyDate(time) : kind
    ? collectionView(value, kind, child => wrap(child, seen), unwrap)
    : objectView(value, seen, root);
  seen.set(value, view);
  snapshotData.set(view, value);
  return view;
}

function objectView(value: object, seen: Views, root: boolean): object {
  // Keep frozen data descriptors for records/arrays, but never put pristine children
  // in them. Register before traversal so collection/object cycles share one view.
  const target: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  const view = root ? new Proxy(target, {
    set: denyMutation, defineProperty: denyMutation,
    deleteProperty: denyMutation, setPrototypeOf: denyMutation
  }) : target;
  seen.set(value, view);
  snapshotData.set(view, value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
    const data = 'value' in descriptor ? descriptor
      : { enumerable: descriptor.enumerable === true, configurable: true, writable: true };
    Reflect.defineProperty(target, key, { ...data, value: wrap(Reflect.get(value, key), seen) });
  }
  Object.freeze(target);
  return view;
}

export function cloneState<T>(input: T): T {
  // Only this module can recover pristine data; each import receives its own clone.
  return structuredClone(unwrap(input)) as T;
}

export function readonlySnapshot<T>(input: T): ReadonlyDeep<T> {
  return wrap(cloneState(input), new WeakMap(), true) as ReadonlyDeep<T>;
}

export function readonlySelectorResult(input: unknown): unknown {
  // Selector inputs are already detached; preserve their views inside computed results.
  return wrap(input, new WeakMap(), true);
}
