import { deriveTurnCommitId } from '../identity/deterministicIds';
import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import { assertIssuedSagaRegistration, type SagaTurnRegistration } from '../routing/registerSagaDefinition';
import type { CompiledSagaRoute } from '../routing/contracts';
import { assertHydratedSagaIdentity, buildExistingTurnEvents, buildInitialTurnEvents } from './aggregateTurn';
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
import { foldSagaTurn, proveOriginalTurn } from './originalTurnProof';
import type { WireRegistryEntry } from '../intentWire';

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

function activeRegistration(resolved: ResolvedSagaTurnRouteGroup, options: SagaTurnProcessorOptions): { identity: DefinitionIdentityV1; start: SagaTurnRegistration | null; on: SagaTurnRegistration | null; registry: readonly WireRegistryEntry[] } {
  const routes = [resolved.startRoute, resolved.onRoute].filter((route): route is CompiledSagaRoute => route !== null);
  if (routes.length === 0 || typeof options.registrationForRoute !== 'function') {
    throw new SagaTurnPermanentError('missing_registration', 'Saga route requires a verified registration');
  }
  let active: DefinitionIdentityV1 | null = null;
  let start: SagaTurnRegistration | null = null;
  let on: SagaTurnRegistration | null = null;
  let registry: readonly WireRegistryEntry[] = [];
  for (const route of routes) {
    let registration;
    try {
      registration = options.registrationForRoute(route);
      assertIssuedSagaRegistration(registration);
    } catch (error) {
      throw new SagaTurnPermanentError('invalid_registration', 'Saga registration is not current', {}, error);
    }
    const identity = registration.definitionIdentity;
    if (registration.definition !== route.definition || identity.sagaKey !== resolved.sagaKey ||
      identity.definitionVersion !== route.definitionVersion || !/^[0-9a-f]{64}$/.test(identity.policySha256) ||
      (active && (active.definitionVersion !== identity.definitionVersion || active.policySha256 !== identity.policySha256))) {
      throw new SagaTurnPermanentError('invalid_registration', 'Saga route registration identity disagrees with compiled route');
    }
    active = identity;
    registry = registration.wireRegistry;
    if (route.kind === 'start') start = registration;
    else on = registration;
  }
  if (!active) throw new SagaTurnPermanentError('missing_registration', 'Saga route requires a verified registration');
  return { identity: active, start, on, registry };
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

async function appendTurn(repository: SagaTurnRepository, request: SagaTurnAppendRequest, resolved: ResolvedSagaTurnRouteGroup,
  candidate: TurnCommitCandidate, firstEventVersion: number) {
  const result = await repository.append(request);
  if (result.status === 'conflict') return null;
  if (result.status === 'reconciled') {
    assertEquivalentCommit(result.commit, candidate);
    repository.assertCommitMaterial(result.commit, request, firstEventVersion);
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
  const { identity: active, start, on, registry } = activeRegistration(resolved, options);
  const loaded = await repository.load(resolved.instanceId);
  const { hydrated, target, nextEventVersion } = await foldSagaTurn(loaded, resolved, registry);
  const exists = hydrated.state.id !== null;
  if (exists) assertHydratedSagaIdentity(hydrated, resolved, active);
  const duplicate = await proveOriginalTurn(repository, resolved, source, active, target, start, on);
  if (duplicate) {
    const candidate = createCandidate(resolved, duplicate);
    return { status: 'reconciled', sagaKey: resolved.sagaKey, sourceTriggerId: resolved.sourceTriggerId,
      instanceId: resolved.instanceId, routeId: duplicate.routeId, commitId: candidate.commitId } satisfies SagaTurnRouteOutcome;
  }
  const route = selectRoute(resolved, exists);
  if (!route) {
    return noWriteOutcome(resolved, exists);
  }
  const candidate = createCandidate(resolved, route);
  let events;
  try {
    events = exists
      ? await buildExistingTurnEvents(hydrated, resolved, source, active, on ?? requireStartRegistration())
      : await buildInitialTurnEvents(hydrated, resolved, source, active, start ?? requireStartRegistration());
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnPermanentError('state_validation_failed', 'Saga turn state or event validation failed', {}, error);
  }
  return appendTurn(repository, {
    streamId: resolved.instanceId,
    commitId: candidate.commitId,
    expectedNextCommitSequence: loaded.nextCommitSequence,
    identity: candidate.identity,
    events
  }, resolved, candidate, nextEventVersion);
}

function requireStartRegistration(): never {
  throw new SagaTurnPermanentError('missing_registration', 'Start route requires an executable registration');
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
