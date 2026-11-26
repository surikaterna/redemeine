import { Buffer } from 'node:buffer';

export const JOIN_MEMBERSHIP_FORMAT = 'set-v1' as const;
export const MAX_JOIN_TARGETS = 1024;
export const MAX_JOIN_TARGET_BYTES = 1024 * 1024;
export const MAX_JOIN_TURN_KEYS = 16_384;
export const MAX_JOIN_TURN_BYTES = 8 * 1024 * 1024;
export const JOIN_MEMBERSHIP_FENCE_CAPACITY = 'Final joined membership fences exceed turn capacity.';
const JOIN_TURN_CAPACITY = 'Joined turn routing exceeds capacity.';

export class ProjectionJoinMembershipValidationError extends Error {}

export class ProjectionJoinCapacityError extends ProjectionJoinMembershipValidationError {}
class ProjectionJoinTurnCapacityError extends ProjectionJoinCapacityError {}

/** A bad durable observation, distinct from an invalid selector or staged membership write. */
export class ProjectionPersistedJoinMembershipError extends ProjectionJoinMembershipValidationError {}

export function assertJoinIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || /[\uD800-\uDFFF]/u.test(value)) {
    throw new ProjectionJoinMembershipValidationError('Joined identifiers must be nonempty, well-formed Unicode strings.');
  }
}

/** Bounds each turn's routing keys and encoded membership input separately from the per-event limit. */
export class JoinTurnBudget {
  private count = 0;
  private bytes = 0;

  assertEntriesAvailable(entries: number): void {
    if (entries > MAX_JOIN_TURN_KEYS - this.count) throw new ProjectionJoinTurnCapacityError(JOIN_TURN_CAPACITY);
  }

  add(value: string): void {
    this.assertEntriesAvailable(1);
    // Fail before allocating the UTF-8 copy when the string alone exceeds the remaining budget.
    if (typeof value === 'string' && value.length > MAX_JOIN_TURN_BYTES - this.bytes) {
      throw new ProjectionJoinTurnCapacityError(JOIN_TURN_CAPACITY);
    }
    assertJoinIdentifier(value);
    this.addMeasured(1, Buffer.byteLength(value));
  }

  /** Charge a validated batch without encoding already measured strings again. */
  addMeasured(entries: number, bytes: number): void {
    this.assertEntriesAvailable(entries);
    if (bytes > MAX_JOIN_TURN_BYTES - this.bytes) throw new ProjectionJoinTurnCapacityError(JOIN_TURN_CAPACITY);
    this.count += entries;
    this.bytes += bytes;
  }
}

export interface ProjectionJoinSource {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

export interface ProjectionJoinMembership extends ProjectionJoinSource {
  readonly targetDocumentIds: readonly string[];
  readonly revision: number | null;
}

export interface ProjectionJoinMembershipFence extends ProjectionJoinSource {
  readonly expectedRevision: number | null;
  readonly targetDocumentIds: readonly string[];
}

/** Tuple encoding also separates the new format from the legacy scalar keys. */
export function joinMembershipKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** Set-mode keys must survive both tuple encoding and standalone BSON fields unchanged. */
export function checkedJoinMembershipKey(...parts: readonly string[]): string {
  for (const part of parts) assertJoinIdentifier(part);
  return joinMembershipKey(...parts);
}

function jsonStringBytes(value: string, utf8Bytes: number): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: JSON escapes these characters, so they affect the byte limit.
  if (!/["\\\u0000-\u001f]/u.test(value)) return utf8Bytes + 2;
  let bytes = utf8Bytes + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 1;
    else if (code < 32) bytes += 5;
  }
  return bytes;
}

/** Returns the raw UTF-8 cost; verifies the JSON row limit without materializing encoded copies. */
export function measureJoinTargetSet(ids: readonly string[]): number {
  if (!Array.isArray(ids)) throw new ProjectionJoinMembershipValidationError('Invalid joined target set.');
  if (ids.length > MAX_JOIN_TARGETS) throw new ProjectionJoinCapacityError('Joined target count exceeds capacity.');
  let jsonBytes = 2;
  let rawBytes = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id === 'string' && jsonBytes + id.length + 2 > MAX_JOIN_TARGET_BYTES) {
      throw new ProjectionJoinCapacityError('Joined target bytes exceed capacity.');
    }
    assertJoinIdentifier(id);
    if (i > 0 && ids[i - 1]! >= id) {
      throw new ProjectionJoinMembershipValidationError('Joined target set must contain sorted, unique IDs.');
    }
    const bytes = Buffer.byteLength(id);
    rawBytes += bytes;
    jsonBytes += jsonStringBytes(id, bytes) + (i === 0 ? 0 : 1);
    if (jsonBytes > MAX_JOIN_TARGET_BYTES) throw new ProjectionJoinCapacityError('Joined target bytes exceed capacity.');
  }
  return rawBytes;
}

export function validateJoinTargetSet(ids: readonly string[]): void {
  measureJoinTargetSet(ids);
}

export function assertJoinRevision(revision: number | null): void {
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)) {
    throw new ProjectionJoinMembershipValidationError('Invalid or exhausted joined membership revision.');
  }
}

export function validateJoinMembershipFences(fences: readonly ProjectionJoinMembershipFence[],
  scope?: { projectionName: string; projectionGeneration: string }): string | null {
  const keys = new Map<string, Set<string>>();
  const keyBudget = new JoinTurnBudget();
  const targetBudget = new JoinTurnBudget();
  try {
    if (!Array.isArray(fences)) throw new Error('Invalid joined membership fences.');
    keyBudget.assertEntriesAvailable(fences.length);
    const scopeBytes = scope ? tuplePartBytes(scope.projectionName) + tuplePartBytes(scope.projectionGeneration) + 2 : 0;
    for (const fence of fences) {
      const { aggregateType, aggregateId, expectedRevision, targetDocumentIds } = fence;
      keyBudget.addMeasured(1, scopeBytes + tuplePartBytes(aggregateType) + tuplePartBytes(aggregateId) + 3);
      const ids = keys.get(aggregateType) ?? new Set<string>();
      if (ids.has(aggregateId)) throw new Error('Duplicate joined membership fence.');
      ids.add(aggregateId);
      keys.set(aggregateType, ids);
      assertJoinRevision(expectedRevision);
      const bytes = measureJoinTargetSet(targetDocumentIds);
      targetBudget.addMeasured(targetDocumentIds.length, bytes);
    }
  } catch (error) {
    if (error instanceof ProjectionJoinTurnCapacityError) return JOIN_MEMBERSHIP_FENCE_CAPACITY;
    return error instanceof Error ? error.message : 'Invalid joined membership fences.';
  }
  return null;
}

function tuplePartBytes(value: string): number {
  if (typeof value === 'string' && value.length > MAX_JOIN_TURN_BYTES) throw new ProjectionJoinTurnCapacityError(JOIN_TURN_CAPACITY);
  assertJoinIdentifier(value);
  return jsonStringBytes(value, Buffer.byteLength(value));
}
