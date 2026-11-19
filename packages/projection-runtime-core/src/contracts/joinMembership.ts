import { isJoinSeedProvenance, type JoinSeedEdge } from './joinSeedProvenance';

export const JOIN_MEMBERSHIP_FORMAT = 'set-v1' as const;
export const MAX_JOIN_TARGETS = 1024;
export const MAX_JOIN_TARGET_BYTES = 1024 * 1024;
export const MAX_JOIN_TURN_KEYS = 16_384;
export const MAX_JOIN_TURN_BYTES = 8 * 1024 * 1024;

/** Bounds each turn's routing keys and encoded membership input separately from the per-event limit. */
export class JoinTurnBudget {
  private readonly encoder = new TextEncoder();
  private count = 0;
  private bytes = 0;

  add(value: string): void {
    // Fail before allocating the UTF-8 copy when the string alone exceeds the remaining budget.
    if (++this.count > MAX_JOIN_TURN_KEYS || value.length > MAX_JOIN_TURN_BYTES - this.bytes) {
      throw new Error('Joined turn routing exceeds capacity.');
    }
    this.bytes += this.encoder.encode(value).byteLength;
    if (this.bytes > MAX_JOIN_TURN_BYTES) throw new Error('Joined turn routing exceeds capacity.');
  }
}

export interface ProjectionJoinSource {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

export interface ProjectionJoinMembership extends ProjectionJoinSource {
  readonly targetDocumentIds: readonly string[];
  readonly revision: number | null;
  readonly seeds?: readonly JoinSeedEdge[];
}

export interface ProjectionJoinMembershipFence extends ProjectionJoinSource {
  readonly expectedRevision: number | null;
  readonly targetDocumentIds: readonly string[];
  readonly seeds?: readonly JoinSeedEdge[];
}

/** Tuple encoding also separates the new format from the legacy scalar keys. */
export function joinMembershipKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export function validateJoinTargetSet(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > MAX_JOIN_TARGETS) throw new Error('Joined target count exceeds capacity.');
  let minimumBytes = 2; // Brackets, quotes and separators plus the minimum UTF-8 bytes of each ID.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || id.length === 0 || (i > 0 && ids[i - 1]! >= id)) {
      throw new Error('Joined target set must contain sorted, unique, nonempty string IDs.');
    }
    minimumBytes += id.length + (i === 0 ? 2 : 3);
    if (minimumBytes > MAX_JOIN_TARGET_BYTES) throw new Error('Joined target bytes exceed capacity.');
  }
  if (new TextEncoder().encode(JSON.stringify(ids)).byteLength > MAX_JOIN_TARGET_BYTES) {
    throw new Error('Joined target bytes exceed capacity.');
  }
}

export function assertJoinRevision(revision: number | null): void {
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid or exhausted joined membership revision.');
  }
}

export function validateJoinMembershipSeeds(row: ProjectionJoinSource & {
  targetDocumentIds: readonly string[]; seeds?: readonly JoinSeedEdge[]
}): void {
  if (row.seeds === undefined) return;
  if (!Array.isArray(row.seeds) || !row.seeds.length || row.seeds.length > row.targetDocumentIds.length) {
    throw new Error('Invalid joined seed provenance list.');
  }
  let previous: string | undefined;
  const targets = new Set(row.targetDocumentIds);
  const budget = new JoinTurnBudget();
  for (const edge of row.seeds) {
    const { targetDocumentId, provenance } = edge;
    if (Object.keys(edge).length !== 2 || !targets.has(targetDocumentId) || (previous !== undefined && previous >= targetDocumentId)
      || !isJoinSeedProvenance(provenance) || provenance.aggregateType !== row.aggregateType || provenance.aggregateId !== row.aggregateId) {
      throw new Error('Invalid joined seed provenance.');
    }
    budget.add(targetDocumentId);
    budget.add(JSON.stringify(provenance));
    previous = targetDocumentId;
  }
}

export function validateJoinMembershipFences(fences: readonly ProjectionJoinMembershipFence[]): string | null {
  const keys = new Set<string>();
  try {
    if (!Array.isArray(fences)) throw new Error('Invalid joined membership fences.');
    for (const fence of fences) {
      const { aggregateType, aggregateId, expectedRevision, targetDocumentIds } = fence;
      if (typeof aggregateType !== 'string' || !aggregateType || typeof aggregateId !== 'string' || !aggregateId) {
        throw new Error('Invalid joined source identity.');
      }
      const key = joinMembershipKey(aggregateType, aggregateId);
      if (keys.has(key)) throw new Error('Duplicate joined membership fence.');
      keys.add(key);
      assertJoinRevision(expectedRevision);
      validateJoinTargetSet(targetDocumentIds);
      validateJoinMembershipSeeds(fence);
    }
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid joined membership fences.';
  }
  return null;
}
