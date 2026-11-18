import {
  equalProjectionChangeJson,
  isPortableProjectionChangeJson,
  type ProjectionChangePatchOperation,
  type ProjectionChangeTransition,
  type ProjectionJsonObject,
  type ProjectionJsonValue,
  type ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';

function isObject(value: ProjectionJsonValue): value is ProjectionJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diffObject(before: ProjectionJsonObject, after: ProjectionJsonObject): ProjectionChangePatchOperation[] {
  const patch: ProjectionChangePatchOperation[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
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
  before: unknown,
  after: unknown,
  creating: boolean
): ProjectionChangeTransition {
  if (!isPortableProjectionChangeJson(after)) throw new Error('Projection changes require portable JSON document state.');
  const identity = { eventId: event.eventId, eventIndex: event.eventIndex };
  if (creating) return { ...identity, changeType: 'create', patch: [{ op: 'add', path: '', value: after }] };
  if (!isPortableProjectionChangeJson(before)) throw new Error('Projection change snapshot must be portable JSON.');
  const patch: ProjectionChangePatchOperation[] = isObject(before) && isObject(after)
    ? diffObject(before, after)
    : equalProjectionChangeJson(before, after) ? [] : [{ op: 'replace', path: '', value: after }];
  return { ...identity, changeType: patch.length ? 'update' : 'noop', patch };
}
