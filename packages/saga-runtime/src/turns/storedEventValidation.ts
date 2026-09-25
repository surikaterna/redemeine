import type { Event } from '@redemeine/kernel';
import { validateBusinessState } from '../businessStateValidation';
import { assertSagaLifecycleState } from '../sagaAggregateContracts';
import { SagaTurnIntegrityError } from './errors';
import { decodeIntent, type WireRegistryEntry } from '../intentWire';
import type { WireIntent } from '../intentWire';
import type { TimerFactV1 } from './lifecycleWire';
import { deriveSourceTriggerId } from '../identity/deterministicIds';
import {
  assertKeys, canonicalCorrelation, invalid, optionalRecord, optionalSafeInteger,
  optionalString, optionalTimestamp, requireRecord, requireSafeInteger,
  requireString, requireTimestamp
} from './storedEventFields';
export {
  assertStoredSagaCommitBoundary, assertStoredSagaReplayOrder,
  createSagaStoredReplayContext, finalizeStoredSagaReplay
} from './storedReplayOrder';
export type { SagaStoredReplayContext } from './storedReplayOrder';

export type SagaStoredEventKind =
  | 'instanceCreated'
  | 'definitionIdentityRecorded'
  | 'sourceEventObserved'
  | 'stateTransitioned'
  | 'intentLifecycleRecorded'
  | 'activityLifecycleRecorded'
  | 'businessStateRecorded'
  | 'intentRecorded'
  | 'timerFactRecorded';

export interface ValidatedStoredSagaEvent {
  readonly event: Event;
  readonly kind: SagaStoredEventKind;
  readonly payload: Record<string, unknown>;
}

const intentStages = new Set(['created', 'scheduled', 'dispatched', 'acknowledged', 'failed', 'cancelled']);
const activityStages = new Set(['started', 'succeeded', 'failed', 'timedOut', 'cancelled']);

function validateInstance(payload: Record<string, unknown>): void {
  assertKeys(payload, ['id', 'sagaType', 'lifecycleState', 'createdAt'], ['metadata'], 'instanceCreated');
  requireString(payload, 'id', 'instanceCreated.id');
  requireString(payload, 'sagaType', 'instanceCreated.sagaType');
  assertSagaLifecycleState(payload.lifecycleState);
  requireTimestamp(payload, 'createdAt', 'instanceCreated.createdAt');
  optionalRecord(payload, 'metadata', 'instanceCreated.metadata');
}

function validateDefinitionIdentity(payload: Record<string, unknown>): void {
  assertKeys(payload, ['schemaVersion', 'sagaKey', 'definitionVersion', 'policySha256'], [], 'definitionIdentityRecorded');
  if (payload.schemaVersion !== 1) throw invalid('Unsupported definition identity version');
  requireString(payload, 'sagaKey', 'definitionIdentityRecorded.sagaKey');
  requireSafeInteger(payload.definitionVersion, 'definitionIdentityRecorded.definitionVersion', 1);
  if (typeof payload.policySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.policySha256)) {
    throw invalid('definitionIdentityRecorded.policySha256 must be a lowercase SHA-256 digest');
  }
}

function validateObserved(payload: Record<string, unknown>): void {
  assertKeys(payload, ['record'], [], 'sourceEventObserved');
  const record = requireRecord(payload.record, 'sourceEventObserved.record');
  assertKeys(record, ['eventType', 'observedAt'], ['sourcePosition', 'aggregateType', 'aggregateId', 'eventId', 'sequence', 'correlationId', 'causationId', 'payload', 'metadata'], 'sourceEventObserved.record');
  requireString(record, 'eventType', 'sourceEventObserved.record.eventType');
  requireTimestamp(record, 'observedAt', 'sourceEventObserved.record.observedAt');
  for (const key of ['aggregateType', 'aggregateId', 'eventId', 'correlationId', 'causationId']) {
    optionalString(record, key, `sourceEventObserved.record.${key}`);
  }
  optionalSafeInteger(record, 'sequence', 'sourceEventObserved.record.sequence');
  optionalRecord(record, 'metadata', 'sourceEventObserved.record.metadata');
  if (record.sourcePosition !== undefined) {
    const position = requireRecord(record.sourcePosition, 'sourceEventObserved.record.sourcePosition');
    assertKeys(position, ['partitionId', 'streamId', 'commitId', 'eventIndex'], [], 'sourceEventObserved.record.sourcePosition');
    deriveSourceTriggerId({ partitionId: requireString(position, 'partitionId'), streamId: requireString(position, 'streamId'),
      commitId: requireString(position, 'commitId'), eventIndex: requireSafeInteger(position.eventIndex, 'eventIndex') });
  }
}

function validateTransition(payload: Record<string, unknown>): void {
  assertKeys(payload, ['record'], [], 'stateTransitioned');
  const record = requireRecord(payload.record, 'stateTransitioned.record');
  assertKeys(record, ['fromState', 'toState', 'transitionAt'], ['reason', 'metadata'], 'stateTransitioned.record');
  assertSagaLifecycleState(record.fromState);
  assertSagaLifecycleState(record.toState);
  requireTimestamp(record, 'transitionAt', 'stateTransitioned.record.transitionAt');
  optionalString(record, 'reason', 'stateTransitioned.record.reason');
  optionalRecord(record, 'metadata', 'stateTransitioned.record.metadata');
}

function validateRetryPolicy(value: unknown): void {
  if (value === null || value === undefined) return;
  const policy = requireRecord(value, 'intent.retryPolicySnapshot');
  assertKeys(policy, [], ['maxAttempts', 'initialDelayMs', 'maxDelayMs', 'backoffMultiplier', 'timeoutMs', 'metadata'], 'intent.retryPolicySnapshot');
  for (const key of ['maxAttempts', 'initialDelayMs', 'maxDelayMs', 'timeoutMs']) optionalSafeInteger(policy, key, `intent.retryPolicySnapshot.${key}`);
  if (policy.backoffMultiplier !== undefined && (typeof policy.backoffMultiplier !== 'number' || !Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier <= 0)) {
    throw invalid('intent.retryPolicySnapshot.backoffMultiplier must be a positive finite number');
  }
  optionalRecord(policy, 'metadata', 'intent.retryPolicySnapshot.metadata');
}

function validateResponseRef(value: unknown): void {
  if (value === null || value === undefined) return;
  const response = requireRecord(value, 'intent.responseRef');
  assertKeys(response, ['responseKey', 'responseId'], ['receivedAt', 'metadata'], 'intent.responseRef');
  requireString(response, 'responseKey', 'intent.responseRef.responseKey');
  requireString(response, 'responseId', 'intent.responseRef.responseId');
  optionalTimestamp(response, 'receivedAt', 'intent.responseRef.receivedAt');
  optionalRecord(response, 'metadata', 'intent.responseRef.metadata');
}

function validateIntent(payload: Record<string, unknown>): void {
  assertKeys(payload, ['record'], [], 'intentLifecycleRecorded');
  const record = requireRecord(payload.record, 'intentLifecycleRecorded.record');
  assertKeys(record, ['intentId', 'intentType', 'stage', 'recordedAt'], ['executionId', 'retryPolicySnapshot', 'responseRef', 'error', 'metadata'], 'intentLifecycleRecorded.record');
  requireString(record, 'intentId', 'intent.intentId');
  requireString(record, 'intentType', 'intent.intentType');
  const stage = requireString(record, 'stage', 'intent.stage');
  if (!intentStages.has(stage)) throw invalid('intent.stage is invalid');
  requireTimestamp(record, 'recordedAt', 'intent.recordedAt');
  optionalString(record, 'executionId', 'intent.executionId');
  optionalString(record, 'error', 'intent.error');
  optionalRecord(record, 'metadata', 'intent.metadata');
  validateRetryPolicy(record.retryPolicySnapshot);
  validateResponseRef(record.responseRef);
}

function validateActivity(payload: Record<string, unknown>): void {
  assertKeys(payload, ['record'], [], 'activityLifecycleRecorded');
  const record = requireRecord(payload.record, 'activityLifecycleRecorded.record');
  assertKeys(record, ['activityId', 'activityName', 'stage', 'recordedAt'], ['attempt', 'error', 'metadata'], 'activityLifecycleRecorded.record');
  requireString(record, 'activityId', 'activity.activityId');
  requireString(record, 'activityName', 'activity.activityName');
  const stage = requireString(record, 'stage', 'activity.stage');
  if (!activityStages.has(stage)) throw invalid('activity.stage is invalid');
  requireTimestamp(record, 'recordedAt', 'activity.recordedAt');
  optionalSafeInteger(record, 'attempt', 'activity.attempt');
  optionalString(record, 'error', 'activity.error');
  optionalRecord(record, 'metadata', 'activity.metadata');
}

function validateBusiness(payload: Record<string, unknown>): void {
  assertKeys(payload, ['schemaVersion', 'sagaKey', 'definitionVersion', 'correlation', 'sourceTriggerId', 'state', 'recordedAt'], [], 'businessStateRecorded');
  if (payload.schemaVersion !== 1) throw invalid('businessStateRecorded.schemaVersion must be 1');
  requireString(payload, 'sagaKey', 'businessStateRecorded.sagaKey');
  requireSafeInteger(payload.definitionVersion, 'businessStateRecorded.definitionVersion', 1);
  canonicalCorrelation(payload.correlation);
  requireString(payload, 'sourceTriggerId', 'businessStateRecorded.sourceTriggerId');
  requireTimestamp(payload, 'recordedAt', 'businessStateRecorded.recordedAt');
  validateBusinessState(payload.state);
}

function validateIntentEvent(payload: Record<string, unknown>, registry: readonly WireRegistryEntry[]): WireIntent {
  assertKeys(payload, ['schemaVersion', 'intent'], [], 'intentRecorded');
  if (payload.schemaVersion !== 1) throw invalid('Unsupported intent event version');
  return decodeIntent(payload.intent, registry);
}

function validateTimerEvent(payload: Record<string, unknown>): TimerFactV1 {
  assertKeys(payload, ['schemaVersion', 'fact'], [], 'timerFactRecorded');
  if (payload.schemaVersion !== 1) throw invalid('Unsupported timer fact event version');
  const fact = requireRecord(payload.fact, 'timerFactRecorded.fact');
  if (fact.action !== 'schedule' && fact.action !== 'cancelSchedule') throw invalid('Unknown timer action');
  assertKeys(fact, fact.action === 'schedule' ? ['intentId', 'action', 'timerId', 'dueAt'] : ['intentId', 'action', 'timerId'], [], 'timerFactRecorded.fact');
  requireString(fact, 'intentId');
  requireString(fact, 'timerId');
  if (fact.action === 'schedule') requireTimestamp(fact, 'dueAt');
  return fact as unknown as TimerFactV1;
}

const validators: Readonly<Record<SagaStoredEventKind, (payload: Record<string, unknown>) => void>> = {
  instanceCreated: validateInstance,
  definitionIdentityRecorded: validateDefinitionIdentity,
  sourceEventObserved: validateObserved,
  stateTransitioned: validateTransition,
  intentLifecycleRecorded: validateIntent,
  activityLifecycleRecorded: validateActivity,
  businessStateRecorded: validateBusiness,
  intentRecorded: () => { throw invalid('Intent registry required'); },
  timerFactRecorded: validateTimerEvent
};
const storedEventKinds = [
  'instanceCreated',
  'definitionIdentityRecorded',
  'sourceEventObserved',
  'stateTransitioned',
  'intentLifecycleRecorded',
  'activityLifecycleRecorded',
  'businessStateRecorded',
  'intentRecorded',
  'timerFactRecorded'
] as const satisfies readonly SagaStoredEventKind[];

function kindForType(type: string, eventTypes: Readonly<Record<string, string>>): SagaStoredEventKind | null {
  for (const kind of storedEventKinds) {
    if (eventTypes[kind] === type) return kind;
  }
  return null;
}

function isEventType(value: string): value is `${string}.event` {
  return value.endsWith('.event');
}

export function validateStoredSagaEvent(value: unknown, eventTypes: Readonly<Record<string, string>>,
  registry: readonly WireRegistryEntry[] = []): ValidatedStoredSagaEvent {
  try {
    // The complete stored envelope has an independent budget above its 8 MiB business state.
    validateBusinessState(value, { maxBytes: 12 * 1024 * 1024 });
  } catch (error) {
    throw new SagaTurnIntegrityError('invalid_stored_event', 'Stored saga event must be JSON-safe', {}, error);
  }
  const event = requireRecord(value, 'stored event');
  assertKeys(event, ['type', 'payload'], ['id', 'headers', 'metadata'], 'stored event');
  const type = requireString(event, 'type', 'stored event.type');
  if (!isEventType(type)) throw invalid('stored event.type must end in .event');
  const kind = kindForType(type, eventTypes);
  if (!kind) throw new SagaTurnIntegrityError('unknown_stored_event', `Unsupported stored saga event ${type}`);
  const payload = requireRecord(event.payload, 'stored event.payload');
  try {
    if (kind === 'intentRecorded') validateIntentEvent(payload, registry);
    else validators[kind](payload);
  } catch (error) {
    if (error instanceof SagaTurnIntegrityError) throw error;
    throw new SagaTurnIntegrityError('invalid_stored_event', `Stored saga event ${type} is invalid`, { type }, error);
  }
  optionalString(event, 'id', 'stored event.id');
  optionalRecord(event, 'headers', 'stored event.headers');
  optionalRecord(event, 'metadata', 'stored event.metadata');
  return {
    kind,
    payload,
    event: {
      type,
      payload,
      ...(event.id === undefined ? {} : { id: requireString(event, 'id') }),
      ...(event.headers === undefined ? {} : { headers: requireRecord(event.headers, 'stored event.headers') }),
      ...(event.metadata === undefined ? {} : { metadata: requireRecord(event.metadata, 'stored event.metadata') })
    }
  };
}
