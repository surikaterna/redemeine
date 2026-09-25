import { deriveTurnCommitId } from '../identity/deterministicIds';
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

function reconciledOutcome(resolved: ResolvedSagaTurnRouteGroup, candidate: TurnCommitCandidate): SagaTurnRouteOutcome {
  return {
    status: 'reconciled',
    sagaKey: resolved.sagaKey,
    sourceTriggerId: resolved.sourceTriggerId,
    instanceId: resolved.instanceId,
    routeId: candidate.route.routeId,
    commitId: candidate.commitId
  };
}

async function findExistingCommit(repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup): Promise<SagaTurnRouteOutcome | null> {
  const routes = [resolved.startRoute, resolved.onRoute].filter((route): route is CompiledSagaRoute => route !== null);
  let found: TurnCommitCandidate | null = null;
  for (const route of routes) {
    const candidate = createCandidate(resolved, route);
    const stored = await repository.findCommit(resolved.instanceId, candidate.commitId);
    if (!stored) continue;
    assertEquivalentCommit(stored, candidate);
    if (found) throw new SagaTurnIntegrityError('duplicate_turn_commits', 'One source event produced multiple durable turns for a saga');
    found = candidate;
  }
  return found ? reconciledOutcome(resolved, found) : null;
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
  if (result.status === 'reconciled') assertEquivalentCommit(result.commit, candidate);
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

async function processAttempt(repository: SagaTurnRepository, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent) {
  const existing = await findExistingCommit(repository, resolved);
  if (existing) return existing;
  const snapshot = await repository.load(resolved.instanceId);
  const hydrated = await hydrateSagaTurn(snapshot, resolved.instanceId);
  const exists = hydrated.state.id !== null;
  const route = selectRoute(resolved, exists);
  if (!route) {
    if (exists) assertHydratedSagaIdentity(hydrated, resolved);
    return noWriteOutcome(resolved, exists);
  }
  const candidate = createCandidate(resolved, route);
  let events;
  try {
    events = exists
      ? await buildExistingTurnEvents(hydrated, resolved, source)
      : buildInitialTurnEvents(hydrated, resolved, source);
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
  options: SagaTurnProcessorOptions = {}
): Promise<SagaTurnRouteOutcome> {
  const limit = retryLimit(options);
  try {
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      const outcome = await processAttempt(repository, resolved, source);
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
