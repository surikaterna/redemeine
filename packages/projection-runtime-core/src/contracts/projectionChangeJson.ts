import { types } from 'node:util';
import { isProjectionJsonValue, type ProjectionJsonValue } from './sourceCommit';

const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const frozenPortableRoots = new WeakSet<object>();

export function isPortableProjectionChangeKey(key: string): boolean {
  return !key.includes('\0') && !unpairedSurrogate.test(key);
}

/** BSON must not reinterpret or lose any part of the declared JSON value. */
export function isPortableProjectionChangeJson(value: unknown): value is ProjectionJsonValue {
  return isPortableJson(value, false);
}

/** A frozen root alone is not enough to reuse a portability check across handler calls. */
export function isFrozenPortableProjectionChangeJson(value: unknown): value is ProjectionJsonValue {
  return Object.isFrozen(value) && isPortableJson(value, true);
}

export function isCertifiedProjectionSnapshotJson(value: unknown): value is ProjectionJsonValue {
  return value !== null && typeof value === 'object' && frozenPortableRoots.has(value);
}

/** For adapter-owned, detached data only. Validation is reusable while the same immutable root lives. */
export function freezePortableProjectionChangeJson(value: unknown): value is ProjectionJsonValue {
  if (!isPortableProjectionChangeJson(value)) return false;
  if (!value || typeof value !== 'object' || isCertifiedProjectionSnapshotJson(value)) return true;
  const pending: ProjectionJsonValue[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' || seen.has(next)) continue;
    if (types.isProxy(next)) return false;
    seen.add(next);
    for (const child of Object.values(next)) pending.push(child);
    Object.freeze(next);
  }
  frozenPortableRoots.add(value);
  return true;
}

function isPortableJson(value: unknown, frozen: boolean): value is ProjectionJsonValue {
  if (isCertifiedProjectionSnapshotJson(value)) return true;
  if (!isProjectionJsonValue(value)) return false;
  const pending: ProjectionJsonValue[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string' && unpairedSurrogate.test(current)) return false;
    // JSON serialization and draft patch capture do not reliably preserve the sign of zero.
    if (typeof current === 'number' && Object.is(current, -0)) return false;
    if (!current || typeof current !== 'object') continue;
    if (frozen && !Object.isFrozen(current)) return false;
    // Immer does not capture every edit of an own __proto__ member.
    if (!Array.isArray(current) && (Object.hasOwn(current, '__proto__') || current._bsontype != null
      || (typeof current.$ref === 'string' && current.$id != null))) return false;
    for (const [key, child] of Object.entries(current)) {
      if (!isPortableProjectionChangeKey(key)) return false;
      pending.push(child);
    }
  }
  return true;
}

/** Equality of validated JSON data, independent of object key order and realm. */
export function equalProjectionChangeJson(left: ProjectionJsonValue, right: ProjectionJsonValue, exact = false): boolean {
  const pending: Array<readonly [ProjectionJsonValue, ProjectionJsonValue]> = [[left, right]];
  for (let pair = pending.pop(); pair; pair = pending.pop()) {
    const [a, b] = pair;
    if (exact ? Object.is(a, b) : a === b) continue;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    const otherKeys = Object.keys(b);
    if (keys.length !== otherKeys.length || (exact && keys.some((key, index) => key !== otherKeys[index]))) return false;
    const av = a as Record<string, ProjectionJsonValue>;
    const bv = b as Record<string, ProjectionJsonValue>;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([av[key]!, bv[key]!]);
    }
  }
  return true;
}
