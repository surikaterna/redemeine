import { createReadonlyDeepProxy } from '@redemeine/kernel';
import type { AggregateStateView as ReadonlyDeep } from '@redemeine/aggregate';
import { dateTime, readonlyDate } from './readonlyDate';

const snapshotData = new WeakMap<object, object>();

function freezeData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  const time = dateTime(value);
  if (time !== undefined) return readonlyDate(time);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    Reflect.set(value, key, freezeData(Reflect.get(value, key), seen));
  }
  return Object.freeze(value);
}

export function cloneState<T>(input: T): T {
  const data = input && typeof input === 'object' ? snapshotData.get(input) ?? input : input;
  // A readonly snapshot has the same data shape as its source, behind a private proxy.
  return structuredClone(data) as T;
}

export function readonlySnapshot<T>(input: T): ReadonlyDeep<T> {
  const data = cloneState(input);
  // Descriptor reads must not bypass the readonly proxy for nested domain records.
  // Keep pristine clone data for cloneState; Date-safe views contain private proxies.
  const view = createReadonlyDeepProxy(freezeData(cloneState(data)));
  if (data && typeof data === 'object' && view && typeof view === 'object') snapshotData.set(view, data);
  return view as ReadonlyDeep<T>;
}
