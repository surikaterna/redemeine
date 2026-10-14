import { createReadonlyDeepProxy, type ReadonlyDeep } from '@redemeine/kernel';

const snapshotData = new WeakMap<object, object>();

function freezeData(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeData(Reflect.get(value, key), seen);
  Object.freeze(value);
}

export function cloneState<T>(input: T): T {
  const data = input && typeof input === 'object' ? snapshotData.get(input) ?? input : input;
  // A readonly snapshot has the same data shape as its source, behind a private proxy.
  return structuredClone(data) as T;
}

export function readonlySnapshot<T>(input: T): ReadonlyDeep<T> {
  const data = cloneState(input);
  // Descriptor reads must not bypass the readonly proxy for nested domain records.
  freezeData(data);
  const view = createReadonlyDeepProxy(data);
  if (data && typeof data === 'object' && view && typeof view === 'object') snapshotData.set(view, data);
  return view;
}
