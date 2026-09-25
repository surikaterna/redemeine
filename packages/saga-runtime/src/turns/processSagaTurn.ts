import { deriveTurnCommitId } from '../identity/deterministicIds';
import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import { assertIssuedSagaRegistration } from '../routing/registerSagaDefinition';
import type { CompiledSagaRoute } from '../routing/contracts';
import { assertHydratedSagaIdentity, buildExistingTurnEvents, buildInitialTurnEvents, hydrateSagaTurn } from './aggregateTurn';
import type {
  ResolvedSagaTurnRouteGroup,
  SagaTurnAppendRequest,
  SagaTurnIdentity,
  SagaTurnProcessorOptions,
  SagaTurnRepository,
  SagaTurnRouteOutcome,
  SagaTurnSourceEvent,
  SagaTurnStoredCommit
} from './contracts';
import { SagaTurnError, SagaTurnIntegrityError, SagaTurnPermanentError, SagaTurnTransientError } from './errors';

interface TurnCommitCandidate {
  readonly route: CompiledSagaRoute;
  readonly identity: SagaTurnIdentity;
  readonly commitId: string;
}

function createCandidate(resolved: ResolvedSagaTurnRouteGroup, route: CompiledSagaRoute): TurnCommitCandidate {
  const identity = {
    sourceTriggerId: resolved.sourceTriggerId,
    sagaKey: resolved.sagaKey,
    instanceId: resolved.instanceId,
    routeId: route.routeId
  };
  return { route, identity, commitId: deriveTurnCommitId(identity) };
}

function sameIdentity(left: SagaTurnIdentity, right: SagaTurnIdentity): boolean {
  return left.sourceTriggerId === right.sourceTriggerId
    && left.sagaKey === right.sagaKey
    && left.instanceId === right.instanceId
    && left.routeId === right.routeId;
}

function assertEquivalentCommit(stored: SagaTurnStoredCommit, candidate: TurnCommitCandidate): void {
  if (stored.streamId !== candidate.identity.instanceId || stored.commitId !== candidate.commitId || !sameIdentity(stored.identity, candidate.identity)) {
    throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Deterministic turn commit identity is already used incompatibly', {
      commitId: candidate.commitId
    });
  }
  if (!Number.isSafeInteger(stored.commitSequence) || stored.commitSequence < 0) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Stored turn commit sequence must be a non-negative safe integer');
  }
}

async function refuseExistingCommit(repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup): Promise<void> {
  const routes = [resolved.startRoute, resolved.onRoute].filter((route): route is CompiledSagaRoute => route !== null);
  for (const route of routes) {
    const candidate = createCandidate(resolved, route);
    const stored = await repository.findCommit(resolved.instanceId, candidate.commitId);
    if (!stored) continue;
    assertEquivalentCommit(stored, candidate);
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Historical saga turn cannot be ACKed until original-prefix material is proven');
  }
}

function activeIdentity(resolved: ResolvedSagaTurnRouteGroup, options: SagaTurnProcessorOptions): DefinitionIdentityV1 {
  const route = resolved.onRoute ?? resolved.startRoute;
  if (!route || typeof options.registrationForRoute !== 'function') {
    throw new SagaTurnPermanentError('missing_registration', 'Saga route requires a verified registration');
  }
  let registration;
  try {
    registration = options.registrationForRoute(route);
    assertIssuedSagaRegistration(registration);
  } catch (error) {
    throw new SagaTurnPermanentError('invalid_registration', 'Saga registration is not current', {}, error);
  }
  const identity = registration.definitionIdentity;
  if (registration.definition !== route.definition || identity.sagaKey !== resolved.sagaKey ||
    identity.definitionVersion !== route.definitionVersion || !/^[0-9a-f]{64}$/.test(identity.policySha256)) {
    throw new SagaTurnPermanentError('invalid_registration', 'Saga route registration identity disagrees with compiled route');
  }
  return identity;
}

function selectRoute(resolved: ResolvedSagaTurnRouteGroup, exists: boolean): CompiledSagaRoute | null {
  return exists ? resolved.onRoute : resolved.startRoute;
}

function noWriteOutcome(resolved: ResolvedSagaTurnRouteGroup, exists: boolean): SagaTurnRouteOutcome {
  return {
    status: exists ? 'no_op' : 'unmatched',
    sagaKey: resolved.sagaKey,
    sourceTriggerId: resolved.sourceTriggerId,
    instanceId: resolved.instanceId,
    reason: exists ? 'existing_start_only' : 'absent_on_route'
  };
}

async function appendTurn(repository: SagaTurnRepository, request: SagaTurnAppendRequest, resolved: ResolvedSagaTurnRouteGroup, candidate: TurnCommitCandidate) {
  const result = await repository.append(request);
  if (result.status === 'conflict') return null;
  if (result.status === 'reconciled') {
    assertEquivalentCommit(result.commit, candidate);
    throw new SagaTurnPermanentError('duplicate_proof_required', 'Concurrent saga turn cannot be ACKed without original-prefix proof');
  }
  if (result.status === 'committed' && (!Number.isSafeInteger(result.commitSequence) || result.commitSequence < 0)) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Committed turn sequence must be a non-negative safe integer');
  }
  return {
    status: result.status,
    sagaKey: resolved.sagaKey,
    sourceTriggerId: resolved.sourceTriggerId,
    instanceId: resolved.instanceId,
    routeId: candidate.route.routeId,
    commitId: candidate.commitId
  } satisfies SagaTurnRouteOutcome;
}

function retryLimit(options: SagaTurnProcessorOptions): number {
  const value = options.maxConflictRetries ?? 3;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SagaTurnPermanentError('invalid_processor_options', 'maxConflictRetries must be a non-negative safe integer');
  }
  return value;
}

async function processAttempt(repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent, options: SagaTurnProcessorOptions) {
  const active = activeIdentity(resolved, options);
  const snapshot = await repository.load(resolved.instanceId);
  const hydrated = await hydrateSagaTurn(snapshot, resolved.instanceId);
  const exists = hydrated.state.id !== null;
  if (exists) assertHydratedSagaIdentity(hydrated, resolved, active);
  await refuseExistingCommit(repository, resolved);
  const route = selectRoute(resolved, exists);
  if (!route) {
    return noWriteOutcome(resolved, exists);
  }
  const candidate = createCandidate(resolved, route);
  let events;
  try {
    events = exists
      ? await buildExistingTurnEvents(hydrated, resolved, source, active)
      : buildInitialTurnEvents(hydrated, resolved, source, active);
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnPermanentError('state_validation_failed', 'Saga turn state or event validation failed', {}, error);
  }
  return appendTurn(repository, {
    streamId: resolved.instanceId,
    commitId: candidate.commitId,
    expectedNextCommitSequence: snapshot.nextCommitSequence,
    identity: candidate.identity,
    events
  }, resolved, candidate);
}

export async function processSagaTurn(
  repository: SagaTurnRepository,
  resolved: ResolvedSagaTurnRouteGroup,
  source: SagaTurnSourceEvent,
  options: SagaTurnProcessorOptions
): Promise<SagaTurnRouteOutcome> {
  const limit = retryLimit(options);
  try {
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      const outcome = await processAttempt(repository, resolved, source, options);
      if (outcome) return outcome;
    }
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnTransientError('repository_failure', 'Saga turn repository operation failed', {}, error);
  }
  throw new SagaTurnTransientError('conflict_retry_exhausted', 'Saga turn conflict retry limit was exhausted', {
    sagaKey: resolved.sagaKey,
    instanceId: resolved.instanceId,
    maxConflictRetries: limit
  });
}
