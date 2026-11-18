import {
  equalProjectionChangeJson,
  formatProjectionChangePointer,
  isPortableProjectionChangeJson,
  type ProjectionChangePatchOperation,
  type ProjectionChangeTransition,
  type ProjectionJsonObject,
  type ProjectionJsonValue,
  type ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';
import type { Patch } from 'immer';

export interface CapturedHandlerPatches {
  patches: readonly Patch[];
  beforeHook?: { state: unknown };
}

function isObject(value: ProjectionJsonValue): value is ProjectionJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diffObject(
  before: ProjectionJsonObject,
  after: ProjectionJsonObject,
  parent: readonly (string | number)[],
  patch: ProjectionChangePatchOperation[]
): void {
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const path = [...parent, key];
    if (!Object.hasOwn(after, key)) patch.push({ op: 'remove', path: formatProjectionChangePointer(path) });
    else if (!Object.hasOwn(before, key)) patch.push({ op: 'add', path: formatProjectionChangePointer(path), value: after[key]! });
    else diffValue(before[key]!, after[key]!, path, patch);
  }
}

function diffArray(
  before: ProjectionJsonValue[], after: ProjectionJsonValue[],
  parent: readonly (string | number)[], patch: ProjectionChangePatchOperation[]
): void {
  const shared = Math.min(before.length, after.length);
  for (let index = 0; index < shared; index++) diffValue(before[index]!, after[index]!, [...parent, index], patch);
  for (let index = before.length - 1; index >= shared; index--) {
    patch.push({ op: 'remove', path: formatProjectionChangePointer([...parent, index]) });
  }
  for (let index = shared; index < after.length; index++) {
    patch.push({ op: 'add', path: formatProjectionChangePointer([...parent, index]), value: after[index]! });
  }
}

function diffValue(
  before: ProjectionJsonValue, after: ProjectionJsonValue,
  path: readonly (string | number)[], patch: ProjectionChangePatchOperation[]
): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after)) diffArray(before, after, path, patch);
  else if (isObject(before) && isObject(after)) diffObject(before, after, path, patch);
  else patch.push({ op: 'replace', path: formatProjectionChangePointer(path), value: after });
}

function normalizeImmerPatch({ op, path, value }: Patch): ProjectionChangePatchOperation {
  const pointer = formatProjectionChangePointer(path);
  if (op === 'remove') return { op, path: pointer };
  if (!isPortableProjectionChangeJson(value)) throw new Error('Projection change patch value must be portable JSON.');
  return { op, path: pointer, value };
}

function eventPatch(
  before: ProjectionJsonValue, after: ProjectionJsonValue, captured?: CapturedHandlerPatches
): ProjectionChangePatchOperation[] {
  if (equalProjectionChangeJson(before, after)) return [];
  const beforeHook = captured?.beforeHook;
  if (captured && !beforeHook) return captured.patches.map(normalizeImmerPatch);
  if (captured && beforeHook && isPortableProjectionChangeJson(beforeHook.state)) {
    const patch = captured.patches.map(normalizeImmerPatch);
    diffValue(beforeHook.state, after, [], patch);
    return patch;
  }
  // A mutable hook may normalize a non-JSON intermediate; only the event's net JSON change is then recordable.
  const patch: ProjectionChangePatchOperation[] = [];
  diffValue(before, after, [], patch);
  return patch;
}

export function createProjectionChangeTransition(
  event: ProjectionSourceEvent,
  before: ProjectionJsonValue | undefined,
  after: ProjectionJsonValue,
  creating: boolean,
  captured?: CapturedHandlerPatches
): ProjectionChangeTransition {
  const identity = { eventId: event.eventId, eventIndex: event.eventIndex };
  if (creating) return { ...identity, changeType: 'create', patch: [{ op: 'add', path: '', value: after }] };
  if (before === undefined) throw new Error('Missing projection change snapshot.');
  const patch = eventPatch(before, after, captured);
  return { ...identity, changeType: patch.length ? 'update' : 'noop', patch };
}
