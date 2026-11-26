import {
  assertJoinRevision, checkedJoinMembershipKey, freezeJoinSeedEdges, JoinTurnBudget, joinMembershipKey,
  mergeJoinTargets, validateJoinMembershipSeeds, validateJoinTargetSet,
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
    try {
      assertJoinRevision(revision);
      validateJoinTargetSet(targetDocumentIds);
      validateJoinMembershipSeeds(row);
      for (const id of targetDocumentIds) budget.add(id);
    } catch (error) {
      if (!(error instanceof ProjectionJoinMembershipValidationError)) throw error;
      throw new ProjectionPersistedJoinMembershipError(error.message, { cause: error });
    }
    if (revision === null && targetDocumentIds.length) throw new ProjectionPersistedJoinMembershipError('Absent membership cannot have targets.');
    result.set(key, Object.freeze({ aggregateType, aggregateId, revision, targetDocumentIds: Object.freeze([...targetDocumentIds]),
      ...(row.seeds ? { seeds: freezeJoinSeedEdges(row.seeds) } : {}) }));
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
export function collectSetTargets<TState>(events: readonly (SetRoutingEntry<TState> | null)[], loaded: Iterable<string>,
  memberships: ReadonlyMap<string, ProjectionJoinMembership>): Set<string> {
  const ids = new Set<string>();
  const budget = new JoinTurnBudget();
  function add(id: string) {
    if (ids.has(id)) return;
    budget.add(id);
    ids.add(id);
  }
  for (const id of loaded) add(id);
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

export function stageMembership(
  rows: Map<string, ProjectionJoinMembership>, missing: Map<string, ProjectionJoinSource>,
  source: ProjectionJoinSource, target: string, subscribe: boolean
): void {
  const key = checkedJoinMembershipKey(source.aggregateType, source.aggregateId);
  const prior = rows.get(key);
  if (!prior) {
    missing.set(key, source);
    return;
  }
  const targets = new Set(prior.targetDocumentIds);
  if (subscribe) targets.add(target);
  else targets.delete(target);
  const targetDocumentIds = [...targets].sort();
  validateJoinTargetSet(targetDocumentIds);
  rows.set(key, { ...prior, targetDocumentIds });
}

export function membershipFences(rows: Iterable<ProjectionJoinMembership>): readonly ProjectionJoinMembershipFence[] {
  return [...rows].map(({ revision, ...row }) => ({ ...row, expectedRevision: revision }));
}
