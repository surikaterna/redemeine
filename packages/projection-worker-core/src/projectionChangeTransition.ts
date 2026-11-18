import {
  equalProjectionChangeJson,
  isPortableProjectionChangeJson,
  type ProjectionChangePatchOperation,
  type ProjectionChangeTransition,
  type ProjectionJsonObject,
  type ProjectionJsonValue,
  type ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';
import type { Patch } from 'immer';

function isObject(value: ProjectionJsonValue): value is ProjectionJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function memberPatch(
  before: ProjectionJsonObject,
  after: ProjectionJsonObject,
  patches?: readonly Patch[]
): ProjectionChangePatchOperation[] {
  const patch: ProjectionChangePatchOperation[] = [];
  // Only top-level members are part of the durable patch contract. A mutable hook or root edit can change any member.
  const candidates = patches && patches.every(({ path }) => path.length > 0)
    ? patches.map(({ path }) => String(path[0]))
    : [...Object.keys(before), ...Object.keys(after)];
  const keys = [...new Set(candidates)].sort();
  for (const key of keys) {
    const path = `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const value = Object.hasOwn(after, key) ? after[key] : undefined;
    if (value === undefined) patch.push({ op: 'remove', path });
    else if (!Object.hasOwn(before, key)) patch.push({ op: 'add', path, value });
    else if (!equalProjectionChangeJson(before[key]!, value)) patch.push({ op: 'replace', path, value });
  }
  return patch;
}

export function createProjectionChangeTransition(
  event: ProjectionSourceEvent,
  before: ProjectionJsonValue | undefined,
  after: unknown,
  creating: boolean,
  patches?: readonly Patch[]
): ProjectionChangeTransition {
  if (!isPortableProjectionChangeJson(after)) throw new Error('Projection changes require portable JSON document state.');
  const identity = { eventId: event.eventId, eventIndex: event.eventIndex };
  if (creating) return { ...identity, changeType: 'create', patch: [{ op: 'add', path: '', value: after }] };
  if (before === undefined) throw new Error('Missing projection change snapshot.');
  const patch: ProjectionChangePatchOperation[] = isObject(before) && isObject(after)
    ? memberPatch(before, after, patches)
    : equalProjectionChangeJson(before, after) ? [] : [{ op: 'replace', path: '', value: after }];
  return { ...identity, changeType: patch.length ? 'update' : 'noop', patch };
}
