import type { ProjectionCandidateSelector } from './createProjection';
import type { ProjectionEvent } from './types';
import { MAX_JOIN_TARGETS, ProjectionJoinMembershipValidationError, validateJoinTargetSet } from './contracts/joinMembership';

/** Pure routing phase. No state, store or handler context is available to selectors. */
export function selectJoinTargets(
  event: ProjectionEvent,
  saved: readonly string[],
  selector?: ProjectionCandidateSelector
): readonly string[] {
  return mergeJoinTargets(saved, selectJoinCandidates(event, selector));
}

/** Candidate discovery is independent of membership and reusable across OCC attempts. */
export function selectJoinCandidates(event: ProjectionEvent, selector?: ProjectionCandidateSelector): readonly string[] {
  // Selectors cannot mutate the event subsequently consumed by handlers or other definitions.
  const selected: unknown = selector?.(structuredClone(event));
  if (selected && typeof (selected as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(selected).catch(() => undefined);
    throw new ProjectionJoinMembershipValidationError('Projection .joinRight() selector must be synchronous.');
  }
  const candidates: readonly unknown[] = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
  const unique = new Set<string>();
  for (const id of candidates) {
    if (typeof id !== 'string' || !id) throw new ProjectionJoinMembershipValidationError('Invalid projection .joinRight() candidate ID.');
    unique.add(id);
    if (unique.size > MAX_JOIN_TARGETS) throw new ProjectionJoinMembershipValidationError('Joined target count exceeds capacity.');
  }
  const targets = [...unique].sort();
  validateJoinTargetSet(targets);
  return Object.freeze(targets);
}

export function mergeJoinTargets(saved: readonly string[], candidates: readonly string[]): readonly string[] {
  const union = [...new Set([...saved, ...candidates])].sort();
  validateJoinTargetSet(union);
  return union;
}
