import type { Event } from '@redemeine/kernel';
import { validateBusinessState } from '../businessStateValidation';
import { assertCanonicalSagaCorrelation, type SagaCanonicalCorrelation } from '../identity/canonicalCorrelation';
import { assertSagaLifecycleState } from '../sagaAggregateContracts';
import { SagaTurnIntegrityError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SagaTurnIntegrityError('invalid_stored_event', `${label} must be an object`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SagaTurnIntegrityError('invalid_stored_event', `${key} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>, key: string): void {
  const value = requireString(record, key);
  if (Number.isNaN(new Date(value).getTime())) throw new SagaTurnIntegrityError('invalid_stored_event', `${key} must be a valid timestamp`);
}

function validateInstanceCreated(payload: Record<string, unknown>): void {
  requireString(payload, 'id');
  requireString(payload, 'sagaType');
  requireTimestamp(payload, 'createdAt');
  assertSagaLifecycleState(payload.lifecycleState);
}

function validateObserved(payload: Record<string, unknown>): void {
  const record = requireRecord(payload.record, 'source event record');
  requireString(record, 'eventType');
  requireTimestamp(record, 'observedAt');
}

function validateTransition(payload: Record<string, unknown>): void {
  const record = requireRecord(payload.record, 'transition record');
  assertSagaLifecycleState(record.fromState);
  assertSagaLifecycleState(record.toState);
  requireTimestamp(record, 'transitionAt');
}

function validateIntent(payload: Record<string, unknown>): void {
  const record = requireRecord(payload.record, 'intent record');
  requireString(record, 'intentId');
  requireString(record, 'intentType');
  requireString(record, 'stage');
  requireTimestamp(record, 'recordedAt');
}

function validateActivity(payload: Record<string, unknown>): void {
  const record = requireRecord(payload.record, 'activity record');
  requireString(record, 'activityId');
  requireString(record, 'activityName');
  requireString(record, 'stage');
  requireTimestamp(record, 'recordedAt');
}

function validateBusiness(payload: Record<string, unknown>): void {
  if (payload.schemaVersion !== 1) throw new SagaTurnIntegrityError('invalid_stored_event', 'business state schemaVersion must be 1');
  requireString(payload, 'sagaKey');
  requireString(payload, 'sourceTriggerId');
  requireTimestamp(payload, 'recordedAt');
  if (typeof payload.definitionVersion !== 'number' || !Number.isSafeInteger(payload.definitionVersion) || payload.definitionVersion <= 0) {
    throw new SagaTurnIntegrityError('invalid_stored_event', 'definitionVersion must be a positive safe integer');
  }
  const correlation = requireRecord(payload.correlation, 'correlation');
  let canonical: SagaCanonicalCorrelation;
  if (correlation.type === 'string' && typeof correlation.value === 'string') {
    canonical = { type: 'string', value: correlation.value };
  } else if (correlation.type === 'number' && typeof correlation.value === 'number') {
    canonical = { type: 'number', value: correlation.value };
  } else {
    throw new SagaTurnIntegrityError('invalid_stored_event', 'correlation must be canonical');
  }
  assertCanonicalSagaCorrelation(canonical);
  validateBusinessState(payload.state);
}

type PayloadValidator = (payload: Record<string, unknown>) => void;

function validatorsByType(eventTypes: Readonly<Record<string, string>>): ReadonlyMap<string, PayloadValidator> {
  return new Map([
    [eventTypes.instanceCreated ?? '', validateInstanceCreated],
    [eventTypes.sourceEventObserved ?? '', validateObserved],
    [eventTypes.stateTransitioned ?? '', validateTransition],
    [eventTypes.intentLifecycleRecorded ?? '', validateIntent],
    [eventTypes.activityLifecycleRecorded ?? '', validateActivity],
    [eventTypes.businessStateRecorded ?? '', validateBusiness]
  ]);
}

function isEventType(value: string): value is `${string}.event` {
  return value.endsWith('.event');
}

export function validateStoredSagaEvent(value: unknown, eventTypes: Readonly<Record<string, string>>): Event {
  const event = requireRecord(value, 'stored event');
  const type = requireString(event, 'type');
  if (!isEventType(type)) throw new SagaTurnIntegrityError('invalid_stored_event', 'Stored event type must end in .event');
  const payload = requireRecord(event.payload, 'stored event payload');
  const validator = validatorsByType(eventTypes).get(type);
  if (!validator) throw new SagaTurnIntegrityError('unknown_stored_event', `Unsupported stored saga event ${type}`);
  try {
    validateBusinessState(value);
    validator(payload);
  } catch (error) {
    if (error instanceof SagaTurnIntegrityError) throw error;
    throw new SagaTurnIntegrityError('invalid_stored_event', `Stored saga event ${type} is invalid`, { type }, error);
  }
  const id = event.id;
  const metadata = event.metadata;
  if (id !== undefined && typeof id !== 'string') throw new SagaTurnIntegrityError('invalid_stored_event', 'Stored event id must be a string');
  if (metadata !== undefined && !isRecord(metadata)) throw new SagaTurnIntegrityError('invalid_stored_event', 'Stored event metadata must be an object');
  return { type, payload, ...(id === undefined ? {} : { id }), ...(metadata === undefined ? {} : { metadata }) };
}
