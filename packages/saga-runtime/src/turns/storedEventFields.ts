import {
  assertCanonicalSagaCorrelation,
  type SagaCanonicalCorrelation
} from '../identity/canonicalCorrelation';
import { SagaTurnIntegrityError } from './errors';

export function invalid(message: string): SagaTurnIntegrityError {
  return new SagaTurnIntegrityError('invalid_stored_event', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  return value;
}

export function assertKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw invalid(`${label}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`${label}.${key} is not supported`);
  }
}

export function requireString(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`);
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireString(record, key, label);
}

export function requireTimestamp(record: Record<string, unknown>, key: string, label = key): void {
  if (Number.isNaN(new Date(requireString(record, key, label)).getTime())) throw invalid(`${label} must be a valid timestamp`);
}

export function optionalTimestamp(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireTimestamp(record, key, label);
}

export function optionalRecord(record: Record<string, unknown>, key: string, label = key): void {
  if (record[key] !== undefined) requireRecord(record[key], label);
}

export function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

export function optionalSafeInteger(record: Record<string, unknown>, key: string, label = key, minimum = 0): void {
  if (record[key] !== undefined) requireSafeInteger(record[key], label, minimum);
}

export function canonicalCorrelation(value: unknown): SagaCanonicalCorrelation {
  const correlation = requireRecord(value, 'businessStateRecorded.correlation');
  assertKeys(correlation, ['type', 'value'], [], 'businessStateRecorded.correlation');
  let canonical: SagaCanonicalCorrelation;
  if (correlation.type === 'string' && typeof correlation.value === 'string') canonical = { type: 'string', value: correlation.value };
  else if (correlation.type === 'number' && typeof correlation.value === 'number') canonical = { type: 'number', value: correlation.value };
  else throw invalid('businessStateRecorded.correlation must be canonical');
  assertCanonicalSagaCorrelation(canonical);
  return canonical;
}
