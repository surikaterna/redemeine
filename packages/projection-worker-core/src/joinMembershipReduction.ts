import {
  assertJoinRevision, checkedJoinMembershipKey, JoinTurnBudget, joinMembershipKey, measureJoinTargetSet, mergeJoinTargets, validateJoinTargetSet,
  ProjectionJoinMembershipValidationError, ProjectionPersistedJoinMembershipError,
  type ProjectionJoinMembership, type ProjectionJoinMembershipFence, type ProjectionJoinSource
} from '@redemeine/projection-runtime-core';
import type { RoutedEvent, SetRoutingEntry } from './projectionCommitRouting';

export function observedMemberships(
  rows: readonly ProjectionJoinMembership[] | undefined, keys: readonly ProjectionJoinSource[]
): Map<string, ProjectionJoinMembership> {
  if (!Array.isArray(rows) || rows.length !== keys.length) throw new ProjectionPersistedJoinMembershipError('Incomplete joined membership snapshot.');
  const remaining = new Set(keys.map(({ aggregateType, aggregateId }) => joinMembershipKey(aggregateType, aggregateId)));
  const result = new Map<string, ProjectionJoinMembership>();
  const budget = new JoinTurnBudget();
  for (const row of rows as readonly ProjectionJoinMembership[]) {
    const { aggregateType, aggregateId, revision, targetDocumentIds } = row;
    const key = joinMembershipKey(aggregateType, aggregateId);
    if (!remaining.delete(key)) throw new ProjectionPersistedJoinMembershipError('Unexpected joined membership snapshot key.');
    let bytes: number;
    try {
      assertJoinRevision(revision);
      bytes = measureJoinTargetSet(targetDocumentIds);
    } catch (error) {
      if (!(error instanceof ProjectionJoinMembershipValidationError)) throw error;
      throw new ProjectionPersistedJoinMembershipError(error.message, { cause: error });
    }
    budget.addMeasured(targetDocumentIds.length, bytes);
    if (revision === null && targetDocumentIds.length) throw new ProjectionPersistedJoinMembershipError('Absent membership cannot have targets.');
    result.set(key, Object.freeze({ aggregateType, aggregateId, revision, targetDocumentIds: Object.freeze([...targetDocumentIds]) }));
  }
  return result;
}

export function routeStagedSetEvent<TState>(entry: SetRoutingEntry<TState>, memberships: ReadonlyMap<string, ProjectionJoinMembership>):
  RoutedEvent<TState> {
  const { event, handler, membershipKey, initialTargets } = entry;
  if (membershipKey === undefined) return { event, handler, targetIds: [...new Set(initialTargets)].sort() };
  const saved = memberships.get(membershipKey)!.targetDocumentIds;
  return { event, handler, targetIds: mergeJoinTargets(saved, initialTargets), savedMembers: new Set(saved) };
}

/** A staged attach can only add the current target, so initial recipients bound every later event. */
export function collectSetTargets<TState>(events: readonly (SetRoutingEntry<TState> | null)[],
  memberships: ReadonlyMap<string, ProjectionJoinMembership>): Set<string> {
  const ids = new Set<string>();
  const budget = new JoinTurnBudget();
  function add(id: string) {
    if (ids.has(id)) return;
    budget.add(id);
    ids.add(id);
  }
  const readMemberships = new Set<string>();
  for (const entry of events) {
    if (!entry) continue;
    for (const id of entry.initialTargets) add(id);
    const key = entry.membershipKey;
    if (key === undefined || readMemberships.has(key)) continue;
    readMemberships.add(key);
    for (const id of memberships.get(key)?.targetDocumentIds ?? []) add(id);
  }
  return ids;
}

function hasSortedTarget(ids: readonly string[], id: string): boolean {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = ids[mid]!;
    if (candidate === id) return true;
    if (candidate < id) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

export class JoinMembershipStaging {
  private readonly budget = new JoinTurnBudget();
  private readonly changed = new Map<string, Set<string>>();

  constructor(readonly rows: Map<string, ProjectionJoinMembership>) {}

  stage(missing: Map<string, ProjectionJoinSource>, source: ProjectionJoinSource, target: string, subscribe: boolean): string {
    const key = checkedJoinMembershipKey(source.aggregateType, source.aggregateId);
    // Charge even no-ops and unresolved keys, before allocating event-local edits.
    this.budget.add(key);
    const prior = this.rows.get(key);
    if (!prior) {
      missing.set(key, source);
      return key;
    }
    let targets = this.changed.get(key);
    if ((targets ? targets.has(target) : hasSortedTarget(prior.targetDocumentIds, target)) === subscribe) return key;
    if (!targets) {
      targets = new Set(prior.targetDocumentIds);
      this.changed.set(key, targets);
    }
    if (subscribe) targets.add(target);
    else targets.delete(target);
    return key;
  }

  finishEvent(): void {
    for (const [key, targets] of this.changed) {
      const targetDocumentIds = [...targets].sort();
      validateJoinTargetSet(targetDocumentIds);
      this.rows.set(key, { ...this.rows.get(key)!, targetDocumentIds });
    }
    this.changed.clear();
  }
}

export function membershipFences(rows: Iterable<ProjectionJoinMembership>): readonly ProjectionJoinMembershipFence[] {
  return [...rows].map(({ revision, ...row }) => ({ ...row, expectedRevision: revision }));
}
