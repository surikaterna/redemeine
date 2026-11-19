import {
  equalProjectionChangeJson,
  formatProjectionChangePointer,
  isPortableProjectionChangeJson,
  type ProjectionChangePatchOperation,
  type ProjectionChangeTransition,
  type ProjectionJsonValue,
  type ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';
import type { Patch } from 'immer';

function normalizeImmerPatch({ op, path, value }: Patch): ProjectionChangePatchOperation {
  const pointer = formatProjectionChangePointer(path);
  if (op === 'remove') return { op, path: pointer };
  if (!isPortableProjectionChangeJson(value)) throw new Error('Projection change patch value must be portable JSON.');
  return { op, path: pointer, value };
}

export function createProjectionChangeTransition(
  event: ProjectionSourceEvent,
  before: ProjectionJsonValue | undefined,
  after: ProjectionJsonValue,
  creating: boolean,
  captured?: readonly Patch[]
): ProjectionChangeTransition {
  const identity = { eventId: event.eventId, eventIndex: event.eventIndex };
  if (creating) return { ...identity, changeType: 'create', patch: [{ op: 'add', path: '', value: after }] };
  if (before === undefined || !captured) throw new Error('Missing projection change capture.');
  const patch = equalProjectionChangeJson(before, after) ? [] : captured.map(normalizeImmerPatch);
  return { ...identity, changeType: patch.length ? 'update' : 'noop', patch };
}
