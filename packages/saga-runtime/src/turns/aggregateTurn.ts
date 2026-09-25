import type { Event } from '@redemeine/kernel';
import { runSagaHandler } from '@redemeine/saga';
import { createSagaAggregate, type SagaAggregate, type SagaAggregateState } from '../SagaAggregate';
import { validateBusinessState } from '../businessStateValidation';
import { serializeSagaCorrelation } from '../identity/canonicalCorrelation';
import { deriveSagaTurnEnvelopeId } from '../identity/deterministicIds';
import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import type { ResolvedSagaTurnRouteGroup, SagaTurnIdentity, SagaTurnSourceEvent, SagaTurnStoredCommit, SagaTurnStreamSnapshot } from './contracts';
import { SagaTurnError, SagaTurnIntegrityError, SagaTurnPermanentError, SagaTurnUnsupportedError } from './errors';
import {
  assertStoredSagaReplayOrder,
  createSagaStoredReplayContext,
  finalizeStoredSagaReplay,
  type SagaStoredReplayContext,
  validateStoredSagaEvent
} from './storedEventValidation';

export interface HydratedSagaTurn {
  readonly aggregate: SagaAggregate;
  readonly state: SagaAggregateState;
  readonly definitionIdentity: DefinitionIdentityV1 | null;
}

// Aggregate memory budget is independent of the reader's 1 GiB on-disk instance budget.
export const SAGA_REPLAY_STATE_BYTES = 1024 * 1024;

function assertStateBudget(state: SagaAggregateState): void {
  try {
    validateBusinessState(state, { maxBytes: SAGA_REPLAY_STATE_BYTES });
  } catch (cause) {
    throw new SagaTurnPermanentError('saga_state_too_large', 'Saga aggregate state exceeds the bounded JSON-safe replay budget', {}, cause);
  }
}

function requireEventTypes(aggregate: SagaAggregate): Readonly<Record<string, string>> {
  if (!aggregate.types) throw new SagaTurnIntegrityError('missing_aggregate_types', 'Saga aggregate does not expose event types');
  return aggregate.types.events;
}

function replayCommitEvents(commit: SagaTurnStoredCommit, count: number, version: number, state: SagaAggregateState,
  aggregate: SagaAggregate, replay: SagaStoredReplayContext, eventTypes: Readonly<Record<string, string>>): SagaAggregateState {
  for (let position = 0; position < count; position += 1) {
    const stored = commit.events[position]!;
    if (stored.version !== version + position) throw new SagaTurnIntegrityError('invalid_event_version', 'Saga event versions must be contiguous');
    const { version: _version, ...event } = stored;
    const validated = validateStoredSagaEvent(event, eventTypes);
    assertStoredSagaReplayOrder(replay, validated);
    try {
      state = aggregate.apply(state, validated.event);
      assertStateBudget(state);
    } catch (error) {
      if (error instanceof SagaTurnError) throw error;
      throw new SagaTurnIntegrityError('stored_event_projection_failed', `Stored saga event ${validated.event.type} could not be projected`, {}, error);
    }
  }
  return state;
}

export class SagaTurnReplaySession {
  readonly aggregate = createSagaAggregate();
  private readonly eventTypes = requireEventTypes(this.aggregate);
  private readonly replay = createSagaStoredReplayContext();
  private state: SagaAggregateState = this.aggregate.initialState;
  private sequence = 0;
  private version = 0;

  constructor(private readonly instanceId: string) { assertStateBudget(this.state); }

  get nextCommitSequence(): number { return this.sequence; }
  get nextEventVersion(): number { return this.version; }

  // Only copy a validated <=1 MiB state, before consuming the one target commit.
  prefix(): HydratedSagaTurn {
    assertStateBudget(this.state);
    return { aggregate: this.aggregate, state: structuredClone(this.state), definitionIdentity: this.replay.definitionIdentity };
  }

  apply(commit: SagaTurnStoredCommit): void {
    if (commit.streamId !== this.instanceId || commit.commitSequence !== this.sequence ||
      commit.events.length === 0 || commit.events.length > 256) {
      throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Loaded saga commits must be complete and contiguous');
    }
    this.state = replayCommitEvents(commit, commit.events.length, this.version, this.state, this.aggregate, this.replay, this.eventTypes);
    if (this.sequence === 0 && (!this.replay.authoritative || commit.events.length !== 4 || this.replay.lastKind !== 'businessStateRecorded')) {
      throw new SagaTurnPermanentError('invalid_stored_event', 'Initial saga identity and turn must share one four-event commit');
    }
    this.version += commit.events.length;
    this.sequence += 1;
  }

  finish(nextCommitSequence: number): HydratedSagaTurn {
    if (this.sequence !== nextCommitSequence) throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Captured saga history is incomplete');
    finalizeStoredSagaReplay(this.replay);
    if (this.sequence > 0 && this.state.id === null) {
      throw new SagaTurnIntegrityError('missing_instance_event', 'Stored saga stream has events but no created instance');
    }
    return { aggregate: this.aggregate, state: this.state, definitionIdentity: this.replay.definitionIdentity };
  }
}

export async function hydrateSagaTurn(
  snapshot: SagaTurnStreamSnapshot,
  instanceId: string,
  prefix?: { readonly commitSequence: number; readonly eventOffset: number }
): Promise<HydratedSagaTurn> {
  if (snapshot.streamId !== instanceId) throw new SagaTurnIntegrityError('stream_identity_mismatch', 'Loaded stream does not match saga instance');
  if (!Number.isSafeInteger(snapshot.nextCommitSequence) || snapshot.nextCommitSequence < 0) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Loaded next commit sequence must be a non-negative safe integer');
  }
  if (prefix && (!Number.isSafeInteger(prefix.commitSequence) || prefix.commitSequence < 0
    || prefix.commitSequence >= snapshot.nextCommitSequence || !Number.isSafeInteger(prefix.eventOffset) || prefix.eventOffset < 0)) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Original saga prefix boundary is invalid');
  }
  const aggregate = createSagaAggregate();
  const eventTypes = requireEventTypes(aggregate);
  const replay = createSagaStoredReplayContext();
  let state: SagaAggregateState = aggregate.initialState;
  let sequence = 0;
  let version = 0;
  for await (const commit of snapshot.commits) {
    if (commit.streamId !== instanceId || commit.commitSequence !== sequence || commit.events.length === 0 || commit.events.length > 256) {
      throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Loaded saga commits must be complete and contiguous');
    }
    if (prefix && sequence === prefix.commitSequence && prefix.eventOffset > commit.events.length) {
      throw new SagaTurnIntegrityError('invalid_event_version', 'Original saga event offset is outside the complete commit');
    }
    const through = prefix && sequence === prefix.commitSequence ? prefix.eventOffset : commit.events.length;
    state = replayCommitEvents(commit, through, version, state, aggregate, replay, eventTypes);
    if (sequence === 0 && through === commit.events.length &&
      (!replay.authoritative || commit.events.length !== 4 || replay.lastKind !== 'businessStateRecorded')) {
      throw new SagaTurnPermanentError('invalid_stored_event', 'Initial saga identity and turn must share one four-event commit');
    }
    version += through;
    sequence += 1;
    if (prefix && commit.commitSequence === prefix.commitSequence) break;
  }
  if (sequence !== (prefix ? prefix.commitSequence + 1 : snapshot.nextCommitSequence)) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Captured saga history is incomplete');
  }
  if (!prefix) finalizeStoredSagaReplay(replay);
  if (!prefix && sequence > 0 && state.id === null) {
    throw new SagaTurnIntegrityError('missing_instance_event', 'Stored saga stream has events but no created instance');
  }
  return { aggregate, state, definitionIdentity: replay.definitionIdentity };
}

function assertExistingIdentity(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, active: DefinitionIdentityV1): void {
  const state = turn.state;
  if (state.id !== resolved.instanceId || state.sagaKey !== resolved.sagaKey) {
    throw new SagaTurnIntegrityError('saga_identity_mismatch', 'Stored saga identity does not match the resolved route');
  }
  const version = resolved.onRoute?.definitionVersion ?? resolved.startRoute?.definitionVersion;
  if (state.definitionVersion !== version) {
    throw new SagaTurnPermanentError(
      'definition_version_migration_unsupported',
      'Existing saga definition version cannot be migrated by this processor slice',
      { storedVersion: state.definitionVersion, activeVersion: version }
    );
  }
  if (!turn.definitionIdentity || turn.definitionIdentity.sagaKey !== active.sagaKey ||
    turn.definitionIdentity.definitionVersion !== active.definitionVersion ||
    turn.definitionIdentity.policySha256 !== active.policySha256) {
    throw new SagaTurnPermanentError('definition_identity_mismatch', 'Stored saga policy differs from active registration');
  }
  if (!state.correlation || serializeSagaCorrelation(state.correlation) !== serializeSagaCorrelation(resolved.correlation)) {
    throw new SagaTurnIntegrityError('correlation_mismatch', 'Stored saga correlation does not match the resolved route');
  }
}

function appendCommand(aggregate: SagaAggregate, current: SagaAggregateState, pending: Event[], command: { type: string; payload: unknown },
  identity: SagaTurnIdentity, sourceTime: string): SagaAggregateState {
  const commandId = deriveSagaTurnEnvelopeId(identity, sourceTime, pending.length, 'command');
  const events = aggregate.process(current, { ...command, id: commandId });
  let next = current;
  for (const event of events) {
    const stableEvent = { ...event, id: deriveSagaTurnEnvelopeId(identity, sourceTime, pending.length, 'event') };
    next = aggregate.apply(next, stableEvent);
    pending.push(stableEvent);
  }
  return next;
}

function observationPayload(source: SagaTurnSourceEvent) {
  return {
    eventType: source.type,
    eventId: source.eventId,
    observedAt: source.createDateTime,
    payload: source.payload,
    ...(source.aggregateType === undefined ? {} : { aggregateType: source.aggregateType }),
    ...(source.aggregateId === undefined ? {} : { aggregateId: source.aggregateId }),
    ...(source.sequence === undefined ? {} : { sequence: source.sequence }),
    ...(source.correlationId === undefined ? {} : { correlationId: source.correlationId }),
    ...(source.causationId === undefined ? {} : { causationId: source.causationId }),
    ...(source.metadata === undefined ? {} : { metadata: { ...source.metadata } })
  };
}

function statePayload(state: unknown, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent) {
  const version = resolved.onRoute?.definitionVersion ?? resolved.startRoute?.definitionVersion;
  if (version === undefined) throw new SagaTurnPermanentError('missing_route', 'Cannot record state without a selected route');
  return {
    schemaVersion: 1 as const,
    sagaKey: resolved.sagaKey,
    definitionVersion: version,
    correlation: resolved.correlation,
    sourceTriggerId: resolved.sourceTriggerId,
    state,
    recordedAt: source.createDateTime
  };
}

export function buildInitialTurnEvents(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent, active: DefinitionIdentityV1): readonly Event[] {
  const route = resolved.startRoute;
  if (!route) throw new SagaTurnPermanentError('missing_start_route', 'Cannot initialize a saga from an on-only route');
  const pending: Event[] = [];
  const identity = { sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId };
  let state = turn.state;
  let initialState: unknown;
  try {
    initialState = route.definition.initialState();
  } catch (error) {
    throw new SagaTurnPermanentError('initial_state_failed', 'Saga initialState failed', { sagaKey: resolved.sagaKey }, error);
  }
  state = appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.createInstance({
    id: resolved.instanceId,
    sagaType: route.definition.sagaType,
    createdAt: source.createDateTime
  }), identity, source.createDateTime);
  state = appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.recordDefinitionIdentity({ schemaVersion: 1, ...active }), identity, source.createDateTime);
  state = appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.observeSourceEvent(observationPayload(source)), identity, source.createDateTime);
  appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.recordBusinessState(statePayload(initialState, resolved, source)), identity, source.createDateTime);
  return pending;
}

export async function buildExistingTurnEvents(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent, active: DefinitionIdentityV1): Promise<readonly Event[]> {
  const route = resolved.onRoute;
  if (!route) throw new SagaTurnPermanentError('missing_on_route', 'Cannot update a saga without an on route');
  if (turn.state.businessState === null || turn.state.businessState === undefined) {
    throw new SagaTurnIntegrityError('legacy_business_state_missing', 'Existing saga has no authoritative business state');
  }
  assertExistingIdentity(turn, resolved, active);
  let output;
  try {
    output = await runSagaHandler(turn.state.businessState, resolved.event, route.handler, {
      sagaId: resolved.instanceId,
      correlationId: source.correlationId ?? serializeSagaCorrelation(resolved.correlation),
      causationId: source.causationId ?? source.eventId
    });
  } catch (error) {
    if (error instanceof SagaTurnError) throw error;
    throw new SagaTurnPermanentError('handler_failed', 'Saga on handler failed', { routeId: route.routeId }, error);
  }
  if (output.intents.length > 0) {
    throw new SagaTurnUnsupportedError('unsupported_intents', 'Saga intents are unsupported by the durable state-turn processor', {
      routeId: route.routeId,
      intentCount: output.intents.length
    });
  }
  const pending: Event[] = [];
  const identity = { sourceTriggerId: resolved.sourceTriggerId, sagaKey: resolved.sagaKey, instanceId: resolved.instanceId, routeId: route.routeId };
  const observed = appendCommand(turn.aggregate, turn.state, pending, turn.aggregate.commandCreators.observeSourceEvent(observationPayload(source)), identity, source.createDateTime);
  appendCommand(turn.aggregate, observed, pending, turn.aggregate.commandCreators.recordBusinessState(statePayload(output.state, resolved, source)), identity, source.createDateTime);
  return pending;
}

export function assertHydratedSagaIdentity(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, active: DefinitionIdentityV1): void {
  assertExistingIdentity(turn, resolved, active);
}
