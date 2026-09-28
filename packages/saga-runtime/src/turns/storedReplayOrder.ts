import { serializeSagaCorrelation } from '../identity/canonicalCorrelation';
import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import { assertSagaLifecycleState, type SagaLifecycleState } from '../sagaAggregateContracts';
import { SagaTurnPermanentError } from './errors';
import { canonicalCorrelation, requireRecord, requireSafeInteger, requireString } from './storedEventFields';
import type { WireIntent } from '../intentWire';
import type { TimerFactV1 } from './lifecycleWire';
import type { SagaStoredEventKind, ValidatedStoredSagaEvent } from './storedEventValidation';
import { deriveSourceTriggerId, type SourceTriggerIdentityInput } from '../identity/deterministicIds';
import type { SagaTurnIdentity } from './contracts';

export interface SagaStoredReplayContext {
  created: boolean;
  authoritative: boolean;
  pendingObservations: number;
  lifecycleState: SagaLifecycleState | null;
  lastKind: SagaStoredEventKind | null;
  businessIdentity: string | null;
  definitionIdentity: DefinitionIdentityV1 | null;
  turn: { sagaKey: string; correlation: string; sourceId: string; definitionVersion: number; turnId: string | null;
    nextOrdinal: number; awaitingTimer: WireIntent | null } | null;
  turnStarted: boolean;
  observedSourceId: string | null;
}

export function createSagaStoredReplayContext(): SagaStoredReplayContext {
  return {
    created: false,
    authoritative: false,
    pendingObservations: 0,
    lifecycleState: null,
    lastKind: null,
    businessIdentity: null,
    definitionIdentity: null,
    turn: null,
    turnStarted: false,
    observedSourceId: null
  };
}

function invalidReplay(message: string): SagaTurnPermanentError {
  return new SagaTurnPermanentError('invalid_stored_event', message);
}

function assertTransitionOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>): void {
  const record = requireRecord(payload.record, 'stateTransitioned.record');
  const from = record.fromState;
  const to = record.toState;
  assertSagaLifecycleState(from);
  assertSagaLifecycleState(to);
  if (context.lifecycleState !== from || from === to || from === 'completed' || from === 'failed' || from === 'cancelled') {
    throw invalidReplay('Stored lifecycle transition violates aggregate invariants');
  }
  context.lifecycleState = to;
}

function assertBusinessOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>, identity: SagaTurnIdentity): void {
  if (context.lastKind !== 'sourceEventObserved' || context.pendingObservations !== 1) {
    throw invalidReplay('Each authoritative business state must pair with exactly one preceding source observation');
  }
  if (!context.definitionIdentity || context.definitionIdentity.sagaKey !== payload.sagaKey ||
    context.definitionIdentity.definitionVersion !== payload.definitionVersion) {
    throw invalidReplay('Business state disagrees with recorded definition identity');
  }
  if (payload.sourceTriggerId !== context.observedSourceId || payload.sourceTriggerId !== identity.sourceTriggerId ||
    payload.sagaKey !== identity.sagaKey) throw invalidReplay('Business state disagrees with physical source identity');
  const businessKey = JSON.stringify([
    requireString(payload, 'sagaKey'),
    requireSafeInteger(payload.definitionVersion, 'definitionVersion', 1),
    serializeSagaCorrelation(canonicalCorrelation(payload.correlation))
  ]);
  if (context.businessIdentity !== null && context.businessIdentity !== businessKey) {
    throw invalidReplay('Stored business state identity changes within one saga stream');
  }
  context.businessIdentity = businessKey;
  context.authoritative = true;
  context.pendingObservations = 0;
  context.observedSourceId = null;
  context.turn = { sagaKey: requireString(payload, 'sagaKey'), correlation: serializeSagaCorrelation(canonicalCorrelation(payload.correlation)),
    sourceId: requireString(payload, 'sourceTriggerId'), definitionVersion: requireSafeInteger(payload.definitionVersion, 'definitionVersion', 1),
    turnId: null, nextOrdinal: 0, awaitingTimer: null };
}

function observedSourceId(payload: Record<string, unknown>, identity: SagaTurnIdentity): string {
  const record = requireRecord(payload.record, 'sourceEventObserved.record');
  if (record.sourcePosition === undefined) return identity.sourceTriggerId;
  const position = record.sourcePosition as SourceTriggerIdentityInput;
  const derived = deriveSourceTriggerId(position);
  if (derived !== identity.sourceTriggerId) throw invalidReplay('Observed source position disagrees with physical turn identity');
  return derived;
}

function assertIntentOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>): void {
  const turn = context.turn;
  if (!turn || context.pendingObservations !== 0 || (context.lastKind !== 'businessStateRecorded' && context.lastKind !== 'intentRecorded' && context.lastKind !== 'timerFactRecorded') || turn.awaitingTimer) {
    throw invalidReplay('Intent must follow state or completed preceding intent');
  }
  const intent = payload.intent as WireIntent;
  if (intent.origin.ordinal !== turn.nextOrdinal || intent.origin.sagaKey !== turn.sagaKey ||
    serializeSagaCorrelation(intent.origin.correlation) !== turn.correlation || intent.origin.sourceId !== turn.sourceId ||
    (turn.turnId !== null && turn.turnId !== intent.turnId)) throw invalidReplay('Intent turn identity or ordinal mismatch');
  turn.turnId = intent.turnId;
  turn.nextOrdinal += 1;
  if (intent.kind === 'schedule' || intent.kind === 'cancelSchedule') turn.awaitingTimer = intent;
}

function assertTimerOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>): void {
  const intent = context.turn?.awaitingTimer;
  if (!intent || context.lastKind !== 'intentRecorded') throw invalidReplay('Timer fact must immediately follow its intent');
  const fact = payload.fact as TimerFactV1;
  if ((intent.kind !== 'schedule' && intent.kind !== 'cancelSchedule') || fact.intentId !== intent.intentId ||
    fact.action !== intent.kind || fact.timerId !== intent.timerId ||
    (intent.kind === 'schedule' && (fact.action !== 'schedule' || fact.dueAt !== intent.dueAt))) {
    throw invalidReplay('Timer fact differs from authoritative intent');
  }
  context.turn!.awaitingTimer = null;
}

function assertObservedOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>, identity: SagaTurnIdentity): void {
  if (!context.authoritative && context.lastKind !== 'definitionIdentityRecorded') {
    throw invalidReplay('Initial source must immediately follow definition identity');
  }
  if (context.pendingObservations !== 0 || context.turnStarted || context.turn?.awaitingTimer) {
    throw invalidReplay('Source observation must begin a complete turn');
  }
  context.observedSourceId = observedSourceId(payload, identity);
  context.pendingObservations = 1;
  context.turn = null;
  context.turnStarted = true;
}

export function assertStoredSagaReplayOrder(context: SagaStoredReplayContext, stored: ValidatedStoredSagaEvent,
  identity: SagaTurnIdentity): void {
  if (stored.kind === 'instanceCreated') {
    if (context.created || context.lastKind !== null) throw invalidReplay('Saga stream contains multiple instance creation events');
    if (stored.payload.id !== identity.instanceId) throw invalidReplay('Created instance disagrees with physical turn identity');
    context.created = true;
    const lifecycle = stored.payload.lifecycleState;
    assertSagaLifecycleState(lifecycle);
    context.lifecycleState = lifecycle;
  } else if (!context.created) {
    throw invalidReplay('Saga stream event appears before instance creation');
  } else if (stored.kind === 'definitionIdentityRecorded') {
    if (context.lastKind !== 'instanceCreated' || context.definitionIdentity) throw invalidReplay('Definition identity must occur exactly once immediately after creation');
    context.definitionIdentity = {
      sagaKey: requireString(stored.payload, 'sagaKey'),
      definitionVersion: requireSafeInteger(stored.payload.definitionVersion, 'definitionVersion', 1),
      policySha256: requireString(stored.payload, 'policySha256')
    };
  } else if (!context.definitionIdentity) {
    throw invalidReplay('Saga stream lacks definition identity before its first turn');
  } else if (stored.kind === 'sourceEventObserved') {
    assertObservedOrder(context, stored.payload, identity);
  } else if (stored.kind === 'stateTransitioned') {
    assertTransitionOrder(context, stored.payload);
  } else if (stored.kind === 'businessStateRecorded') {
    assertBusinessOrder(context, stored.payload, identity);
  } else if (stored.kind === 'intentRecorded') {
    assertIntentOrder(context, stored.payload);
  } else if (stored.kind === 'timerFactRecorded') {
    assertTimerOrder(context, stored.payload);
  } else {
    throw invalidReplay('Unsupported legacy saga event in authoritative turn');
  }
  context.lastKind = stored.kind;
}

export function finalizeStoredSagaReplay(context: SagaStoredReplayContext): void {
  if (context.created && (!context.definitionIdentity || !context.authoritative)) {
    throw invalidReplay('Saga stream has no complete identity-bearing initial turn');
  }
  assertStoredSagaCommitBoundary(context);
}

export function assertStoredSagaCommitBoundary(context: SagaStoredReplayContext): void {
  // One physical turn owns both its observation and authoritative business state.
  if (!context.created && context.lastKind === null) return;
  if (context.pendingObservations !== 0 || context.turn?.awaitingTimer ||
    (context.created && !context.authoritative) ||
    (context.lastKind !== 'businessStateRecorded' && context.lastKind !== 'intentRecorded' && context.lastKind !== 'timerFactRecorded')) {
    throw invalidReplay('Physical saga commit ends with an incomplete authoritative turn');
  }
  context.turnStarted = false;
  context.turn = null;
  context.observedSourceId = null;
}
