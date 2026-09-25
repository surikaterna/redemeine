import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import type { CompiledSagaRoute } from '../routing/contracts';
import { assertHydratedSagaIdentity, buildExistingTurnEvents, buildInitialTurnEvents, hydrateSagaTurn } from './aggregateTurn';
import type { ResolvedSagaTurnRouteGroup, SagaTurnAppendRequest, SagaTurnRepository, SagaTurnSourceEvent, SagaTurnStoredCommit, SagaTurnStreamSnapshot } from './contracts';
import { SagaTurnIntegrityError, SagaTurnPermanentError } from './errors';
import { deriveTurnCommitId } from '../identity/deterministicIds';

export async function captureSagaHistory(snapshot: SagaTurnStreamSnapshot): Promise<readonly SagaTurnStoredCommit[]> {
  const commits: SagaTurnStoredCommit[] = [];
  for await (const commit of snapshot.commits) {
    if (commits.length >= 1024 || commit.events.length > 256) {
      throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Saga history exceeds bounded replay budget');
    }
    commits.push(commit);
  }
  if (commits.length !== snapshot.nextCommitSequence) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Saga history is incomplete');
  }
  return commits;
}

export function capturedSnapshot(streamId: string, commits: readonly SagaTurnStoredCommit[]): SagaTurnStreamSnapshot {
  return { streamId, nextCommitSequence: commits.length, commits: (async function* () { yield* commits; })() };
}

export async function proveOriginalTurn(
  repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent,
  active: DefinitionIdentityV1, commits: readonly SagaTurnStoredCommit[]
): Promise<CompiledSagaRoute | null> {
  const routes = [resolved.startRoute, resolved.onRoute].filter((route): route is CompiledSagaRoute => route !== null);
  const matches = routes.map((route) => ({ route, commitId: deriveTurnCommitId({
    sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId
  }) })).filter(({ commitId }) => commits.some((commit) => commit.commitId === commitId));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new SagaTurnIntegrityError('duplicate_turn_commits', 'Multiple saga routes committed the same trigger');
  const { route, commitId } = matches[0]!;
  const index = commits.findIndex((commit) => commit.commitId === commitId);
  const stored = commits[index]!;
  if (commits.filter((commit) => commit.commitId === commitId).length !== 1 || stored.commitSequence !== index) {
    throw new SagaTurnIntegrityError('duplicate_turn_commits', 'Original saga commit cannot be uniquely located');
  }
  const prefix = capturedSnapshot(resolved.instanceId, commits.slice(0, index));
  const original = await hydrateSagaTurn(prefix, resolved.instanceId);
  if (index > 0) assertHydratedSagaIdentity(original, resolved, active);
  if ((index === 0) !== (route.kind === 'start')) {
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Original route does not match saga creation boundary');
  }
  let events;
  try {
    events = index === 0 ? buildInitialTurnEvents(original, resolved, source, active)
      : await buildExistingTurnEvents(original, resolved, source, active);
  } catch (error) {
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Original saga turn cannot be reproduced', {}, error);
  }
  const request: SagaTurnAppendRequest = {
    streamId: resolved.instanceId, commitId, expectedNextCommitSequence: index,
    identity: { sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId }, events
  };
  const version = commits.slice(0, index).reduce((count, commit) => count + commit.events.length, 0);
  repository.assertCommitMaterial(stored, request, version);
  return route;
}
