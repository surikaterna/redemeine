import type { Event } from '@redemeine/kernel';
import { runSagaHandler } from '@redemeine/saga';
import { createSagaAggregate, type SagaAggregate, type SagaAggregateState } from '../SagaAggregate';
import { serializeSagaCorrelation } from '../identity/canonicalCorrelation';
import type { ResolvedSagaTurnRouteGroup, SagaTurnSourceEvent, SagaTurnStreamSnapshot } from './contracts';
import { SagaTurnError, SagaTurnIntegrityError, SagaTurnPermanentError, SagaTurnUnsupportedError } from './errors';
import { validateStoredSagaEvent } from './storedEventValidation';

export interface HydratedSagaTurn {
  readonly aggregate: SagaAggregate;
  readonly state: SagaAggregateState;
}

function requireEventTypes(aggregate: SagaAggregate): Readonly<Record<string, string>> {
  if (!aggregate.types) throw new SagaTurnIntegrityError('missing_aggregate_types', 'Saga aggregate does not expose event types');
  return aggregate.types.events;
}

export function hydrateSagaTurn(snapshot: SagaTurnStreamSnapshot, instanceId: string): HydratedSagaTurn {
  if (snapshot.streamId !== instanceId) throw new SagaTurnIntegrityError('stream_identity_mismatch', 'Loaded stream does not match saga instance');
  if (!Number.isSafeInteger(snapshot.nextCommitSequence) || snapshot.nextCommitSequence < 0) {
    throw new SagaTurnIntegrityError('invalid_commit_sequence', 'Loaded next commit sequence must be a non-negative safe integer');
  }
  const aggregate = createSagaAggregate();
  const eventTypes = requireEventTypes(aggregate);
  let state = aggregate.initialState;
  for (const stored of snapshot.events) {
    const event = validateStoredSagaEvent(stored, eventTypes);
    try {
      state = aggregate.apply(state, event);
    } catch (error) {
      if (error instanceof SagaTurnError) throw error;
      throw new SagaTurnIntegrityError('stored_event_projection_failed', `Stored saga event ${event.type} could not be projected`, {}, error);
    }
  }
  if (snapshot.events.length > 0 && state.id === null) {
    throw new SagaTurnIntegrityError('missing_instance_event', 'Stored saga stream has events but no created instance');
  }
  return { aggregate, state };
}

function assertExistingIdentity(state: SagaAggregateState, resolved: ResolvedSagaTurnRouteGroup): void {
  if (state.id !== resolved.instanceId || state.sagaKey !== resolved.sagaKey) {
    throw new SagaTurnIntegrityError('saga_identity_mismatch', 'Stored saga identity does not match the resolved route');
  }
  const version = resolved.onRoute?.definitionVersion ?? resolved.startRoute?.definitionVersion;
  if (state.definitionVersion !== version) {
    throw new SagaTurnIntegrityError('definition_version_mismatch', 'Stored saga definition version is not active');
  }
  if (!state.correlation || serializeSagaCorrelation(state.correlation) !== serializeSagaCorrelation(resolved.correlation)) {
    throw new SagaTurnIntegrityError('correlation_mismatch', 'Stored saga correlation does not match the resolved route');
  }
}

function appendCommand(aggregate: SagaAggregate, current: SagaAggregateState, pending: Event[], command: { type: string; payload: unknown }): SagaAggregateState {
  const events = aggregate.process(current, command);
  let next = current;
  for (const event of events) {
    next = aggregate.apply(next, event);
    pending.push(event);
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

export function buildInitialTurnEvents(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent): readonly Event[] {
  const route = resolved.startRoute;
  if (!route) throw new SagaTurnPermanentError('missing_start_route', 'Cannot initialize a saga from an on-only route');
  const pending: Event[] = [];
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
  }));
  state = appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.observeSourceEvent(observationPayload(source)));
  appendCommand(turn.aggregate, state, pending, turn.aggregate.commandCreators.recordBusinessState(statePayload(initialState, resolved, source)));
  return pending;
}

function handlerEvent(source: SagaTurnSourceEvent) {
  return {
    type: source.type,
    payload: source.payload,
    ...(source.aggregateType === undefined ? {} : { aggregateType: source.aggregateType }),
    ...(source.aggregateId === undefined ? {} : { aggregateId: source.aggregateId }),
    ...(source.sequence === undefined ? {} : { sequence: source.sequence }),
    ...(source.metadata === undefined ? {} : { metadata: { ...source.metadata } })
  };
}

export async function buildExistingTurnEvents(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup, source: SagaTurnSourceEvent): Promise<readonly Event[]> {
  const route = resolved.onRoute;
  if (!route) throw new SagaTurnPermanentError('missing_on_route', 'Cannot update a saga without an on route');
  if (turn.state.businessState === null || turn.state.businessState === undefined) {
    throw new SagaTurnIntegrityError('legacy_business_state_missing', 'Existing saga has no authoritative business state');
  }
  assertExistingIdentity(turn.state, resolved);
  let output;
  try {
    output = await runSagaHandler(turn.state.businessState, handlerEvent(source), route.handler, {
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
  const observed = appendCommand(turn.aggregate, turn.state, pending, turn.aggregate.commandCreators.observeSourceEvent(observationPayload(source)));
  appendCommand(turn.aggregate, observed, pending, turn.aggregate.commandCreators.recordBusinessState(statePayload(output.state, resolved, source)));
  return pending;
}

export function assertHydratedSagaIdentity(turn: HydratedSagaTurn, resolved: ResolvedSagaTurnRouteGroup): void {
  assertExistingIdentity(turn.state, resolved);
}
