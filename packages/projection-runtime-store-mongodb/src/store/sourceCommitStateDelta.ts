import { types } from 'node:util';
import { formatProjectionChangePointer, type ProjectionChangePatchOperation, type ProjectionJsonValue } from '@redemeine/projection-runtime-core';

type ObjectState = Record<string, unknown>;
type Token = string | number;
const plainPrototypes = new Set([Object.prototype, Object.getPrototypeOf(structuredClone({})), null]);

function plainObject(value: unknown): value is ObjectState {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && plainPrototypes.has(Object.getPrototypeOf(value));
}

function replace(path: readonly Token[], value: unknown): ProjectionChangePatchOperation {
  return { op: 'replace', path: formatProjectionChangePointer(path), value: value as ProjectionJsonValue };
}

function arrayEdits(
  before: unknown[], after: unknown[], path: readonly Token[], result: ProjectionChangePatchOperation[]
): void {
  if (before.length === after.length) {
    for (let i = 0; i < after.length; i++) collect(before[i], after[i], [...path, i], result);
  } else if (after.length === before.length + 1 && before.every((value, i) => Object.is(value, after[i]))) {
    result.push({ op: 'add', path: formatProjectionChangePointer([...path, before.length]), value: after.at(-1) as ProjectionJsonValue });
  } else if (before.length === after.length + 1 && after.every((value, i) => Object.is(value, before[i]))) {
    result.push({ op: 'remove', path: formatProjectionChangePointer([...path, after.length]) });
  } else {
    result.push(replace(path, after));
  }
}

function objectEdits(before: ObjectState, after: ObjectState, path: readonly Token[], result: ProjectionChangePatchOperation[]): void {
  // These markers can change how BSON treats the *container*, not just the edited field.
  if (after._bsontype != null || (typeof after.$ref === 'string' && after.$id != null)) {
    result.push(replace(path, after));
    return;
  }
  const oldKeys = Object.keys(before);
  const newKeys = Object.keys(after);
  const order = [...oldKeys.filter((key) => Object.hasOwn(after, key)), ...newKeys.filter((key) => !Object.hasOwn(before, key))];
  if (order.some((key, index) => key !== newKeys[index])) {
    result.push(replace(path, after));
    return;
  }
  for (const key of oldKeys) {
    if (!Object.hasOwn(after, key)) result.push({ op: 'remove', path: formatProjectionChangePointer([...path, key]) });
  }
  for (const key of newKeys) {
    if (Object.hasOwn(before, key)) collect(before[key], after[key], [...path, key], result);
    else result.push({ op: 'add', path: formatProjectionChangePointer([...path, key]), value: after[key] as ProjectionJsonValue });
  }
}

function collect(before: unknown, after: unknown, path: readonly Token[], result: ProjectionChangePatchOperation[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after) && !types.isProxy(before) && !types.isProxy(after)
    && Object.keys(before).length === before.length && Object.keys(after).length === after.length) {
    arrayEdits(before, after, path, result);
  } else if (plainObject(before) && plainObject(after)) {
    objectEdits(before, after, path, result);
  } else {
    result.push(replace(path, after));
  }
}

/** Derive writes from stable before/after values, not the completeness of diagnostic/history patches. */
export function authoritativeMongoEdits(before: unknown, after: unknown): readonly ProjectionChangePatchOperation[] {
  const result: ProjectionChangePatchOperation[] = [];
  collect(before, after, [], result);
  return result;
}
