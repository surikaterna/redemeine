import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import type { SagaTurnRegistration } from '../routing/registerSagaDefinition';
import type { CompiledSagaRoute } from '../routing/contracts';
import { assertHydratedSagaIdentity, buildExistingTurnEvents, buildInitialTurnEvents, SagaTurnReplaySession, type HydratedSagaTurn } from './aggregateTurn';
import type { ResolvedSagaTurnRouteGroup, SagaTurnAppendRequest, SagaTurnRepository, SagaTurnSourceEvent, SagaTurnStoredCommit, SagaTurnStreamSnapshot } from './contracts';
import { SagaTurnIntegrityError, SagaTurnPermanentError } from './errors';
import { deriveTurnCommitId } from '../identity/deterministicIds';
import type { WireRegistryEntry } from '../intentWire';

export interface SagaTurnFold {
  readonly hydrated: HydratedSagaTurn;
  readonly nextEventVersion: number;
  readonly target: { readonly route: CompiledSagaRoute; readonly stored: SagaTurnStoredCommit;
    readonly original: HydratedSagaTurn; readonly firstEventVersion: number } | null;
}

export async function foldSagaTurn(snapshot: SagaTurnStreamSnapshot, resolved: ResolvedSagaTurnRouteGroup,
  registry: readonly WireRegistryEntry[] = []): Promise<SagaTurnFold> {
  if (snapshot.streamId !== resolved.instanceId || !Number.isSafeInteger(snapshot.nextCommitSequence) ||
    snapshot.nextCommitSequence < 0 || snapshot.nextCommitSequence > 1_000_000) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Invalid captured saga stream boundary');
  }
  const routes = [resolved.startRoute, resolved.onRoute].filter((route): route is CompiledSagaRoute => route !== null);
  const candidates = routes.map((route) => ({ route, commitId: deriveTurnCommitId({
    sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId
  }) }));
  const session = new SagaTurnReplaySession(resolved.instanceId, registry);
  let target: SagaTurnFold['target'] = null;
  for await (const commit of snapshot.commits) {
    if (session.nextCommitSequence >= snapshot.nextCommitSequence) {
      throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Captured saga history exceeds high watermark');
    }
    const match = candidates.find((candidate) => candidate.commitId === commit.commitId);
    if (match) {
      if (target) throw new SagaTurnIntegrityError('duplicate_turn_commits', 'Multiple saga routes committed the same trigger');
      target = { route: match.route, stored: commit, original: session.prefix(), firstEventVersion: session.nextEventVersion };
    }
    session.apply(commit);
  }
  return { hydrated: session.finish(snapshot.nextCommitSequence), nextEventVersion: session.nextEventVersion, target };
}

export async function proveOriginalTurn(
  repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent,
  active: DefinitionIdentityV1, target: SagaTurnFold['target'], start: SagaTurnRegistration | null
): Promise<CompiledSagaRoute | null> {
  if (!target) return null;
  const { route, stored, original, firstEventVersion } = target;
  const index = stored.commitSequence;
  const commitId = stored.commitId;
  if (index > 0) assertHydratedSagaIdentity(original, resolved, active);
  if ((index === 0) !== (route.kind === 'start')) {
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Original route does not match saga creation boundary');
  }
  let events;
  try {
    events = index === 0 ? await buildInitialTurnEvents(original, resolved, source, active, start ?? requireStartRegistration())
      : await buildExistingTurnEvents(original, resolved, source, active);
  } catch (error) {
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Original saga turn cannot be reproduced', {}, error);
  }
  const request: SagaTurnAppendRequest = {
    streamId: resolved.instanceId, commitId, expectedNextCommitSequence: index,
    identity: { sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId }, events
  };
  repository.assertCommitMaterial(stored, request, firstEventVersion);
  return route;
}

function requireStartRegistration(): never {
  throw new SagaTurnPermanentError('missing_registration', 'Start route requires an executable registration');
}
