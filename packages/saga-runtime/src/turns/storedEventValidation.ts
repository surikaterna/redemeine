import type { Event } from '@redemeine/kernel';
import { validateBusinessState } from '../businessStateValidation';
import {
  assertCanonicalSagaCorrelation,
  serializeSagaCorrelation,
  type SagaCanonicalCorrelation
} from '../identity/canonicalCorrelation';
import { assertSagaLifecycleState, type SagaLifecycleState } from '../sagaAggregateContracts';
import type { DefinitionIdentityV1 } from '../routing/executableIdentity';
import { SagaTurnIntegrityError, SagaTurnPermanentError } from './errors';

export type SagaStoredEventKind =
  | 'instanceCreated'
  | 'definitionIdentityRecorded'
  | 'sourceEventObserved'
  | 'stateTransitioned'
  | 'intentLifecycleRecorded'
  | 'activityLifecycleRecorded'
  | 'businessStateRecorded';

export interface ValidatedStoredSagaEvent {
  readonly event: Event;
  readonly kind: SagaStoredEventKind;
  readonly payload: Record<string, unknown>;
}

export interface SagaStoredReplayContext {
  created: boolean;
  authoritative: boolean;
  pendingObservations: number;
  lifecycleState: SagaLifecycleState | null;
  lastKind: SagaStoredEventKind | null;
  businessIdentity: string | null;
  definitionIdentity: DefinitionIdentityV1 | null;
}

const intentStages = new Set(['created', 'scheduled', 'dispatched', 'acknowledged', 'failed', 'cancelled']);
const activityStages = new Set(['started', 'succeeded', 'failed', 'timedOut', 'cancelled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  return value;
}

function invalid(message: string): SagaTurnIntegrityError {
  return new SagaTurnIntegrityError('invalid_stored_event', message);
}

function assertKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw invalid(`${label}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`${label}.${key} is not supported`);
  }
}

function requireString(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireString(record, key, label);
}

function requireTimestamp(record: Record<string, unknown>, key: string, label = key): void {
  if (Number.isNaN(new Date(requireString(record, key, label)).getTime())) throw invalid(`${label} must be a valid timestamp`);
}

function optionalTimestamp(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireTimestamp(record, key, label);
}

function optionalRecord(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireRecord(record[key], label);
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

function optionalSafeInteger(record: Record<string, unknown>, key: string, label = key, minimum = 0): void {
  if (record[key] !== undefined) requireSafeInteger(record[key], label, minimum);
}

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
  assertKeys(record, ['eventType', 'observedAt'], ['aggregateType', 'aggregateId', 'eventId', 'sequence', 'correlationId', 'causationId', 'payload', 'metadata'], 'sourceEventObserved.record');
  requireString(record, 'eventType', 'sourceEventObserved.record.eventType');
  requireTimestamp(record, 'observedAt', 'sourceEventObserved.record.observedAt');
  for (const key of ['aggregateType', 'aggregateId', 'eventId', 'correlationId', 'causationId']) {
    optionalString(record, key, `sourceEventObserved.record.${key}`);
  }
  optionalSafeInteger(record, 'sequence', 'sourceEventObserved.record.sequence');
  optionalRecord(record, 'metadata', 'sourceEventObserved.record.metadata');
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

function canonicalCorrelation(value: unknown): SagaCanonicalCorrelation {
  const correlation = requireRecord(value, 'businessStateRecorded.correlation');
  assertKeys(correlation, ['type', 'value'], [], 'businessStateRecorded.correlation');
  let canonical: SagaCanonicalCorrelation;
  if (correlation.type === 'string' && typeof correlation.value === 'string') canonical = { type: 'string', value: correlation.value };
  else if (correlation.type === 'number' && typeof correlation.value === 'number') canonical = { type: 'number', value: correlation.value };
  else throw invalid('businessStateRecorded.correlation must be canonical');
  assertCanonicalSagaCorrelation(canonical);
  return canonical;
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

const validators: Readonly<Record<SagaStoredEventKind, (payload: Record<string, unknown>) => void>> = {
  instanceCreated: validateInstance,
  definitionIdentityRecorded: validateDefinitionIdentity,
  sourceEventObserved: validateObserved,
  stateTransitioned: validateTransition,
  intentLifecycleRecorded: validateIntent,
  activityLifecycleRecorded: validateActivity,
  businessStateRecorded: validateBusiness
};
const storedEventKinds = [
  'instanceCreated',
  'definitionIdentityRecorded',
  'sourceEventObserved',
  'stateTransitioned',
  'intentLifecycleRecorded',
  'activityLifecycleRecorded',
  'businessStateRecorded'
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

export function validateStoredSagaEvent(value: unknown, eventTypes: Readonly<Record<string, string>>): ValidatedStoredSagaEvent {
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
    validators[kind](payload);
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

export function createSagaStoredReplayContext(): SagaStoredReplayContext {
  return {
    created: false,
    authoritative: false,
    pendingObservations: 0,
    lifecycleState: null,
    lastKind: null,
    businessIdentity: null,
    definitionIdentity: null
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

function assertBusinessOrder(context: SagaStoredReplayContext, payload: Record<string, unknown>): void {
  if (context.lastKind !== 'sourceEventObserved' || context.pendingObservations !== 1) {
    throw invalidReplay('Each authoritative business state must pair with exactly one preceding source observation');
  }
  if (!context.definitionIdentity || context.definitionIdentity.sagaKey !== payload.sagaKey ||
    context.definitionIdentity.definitionVersion !== payload.definitionVersion) {
    throw invalidReplay('Business state disagrees with recorded definition identity');
  }
  const identity = JSON.stringify([
    requireString(payload, 'sagaKey'),
    requireSafeInteger(payload.definitionVersion, 'definitionVersion', 1),
    serializeSagaCorrelation(canonicalCorrelation(payload.correlation))
  ]);
  if (context.businessIdentity !== null && context.businessIdentity !== identity) {
    throw invalidReplay('Stored business state identity changes within one saga stream');
  }
  context.businessIdentity = identity;
  context.authoritative = true;
  context.pendingObservations = 0;
}

export function assertStoredSagaReplayOrder(context: SagaStoredReplayContext, stored: ValidatedStoredSagaEvent): void {
  if (stored.kind === 'instanceCreated') {
    if (context.created || context.lastKind !== null) throw invalidReplay('Saga stream contains multiple instance creation events');
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
    context.pendingObservations += 1;
    if (context.authoritative && context.pendingObservations > 1) {
      throw invalidReplay('A new source observation cannot begin before the prior authoritative turn records business state');
    }
  } else if (stored.kind === 'stateTransitioned') {
    assertTransitionOrder(context, stored.payload);
  } else if (stored.kind === 'businessStateRecorded') {
    assertBusinessOrder(context, stored.payload);
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
  if (context.authoritative && context.pendingObservations !== 0) {
    throw invalidReplay('Physical saga commit ends with a source observation that has no business state');
  }
}
