import { validateBusinessState } from '../businessStateValidation';
import type { SagaTurnSourceEvent } from './contracts';
import { SagaTurnPermanentError } from './errors';

function requireNonEmpty(name: string, value: string): void {
  if (value.length === 0) throw new SagaTurnPermanentError('invalid_source_event', `${name} must not be empty`, { name });
}

function validateOptionalString(name: string, value: string | undefined): void {
  if (value !== undefined) requireNonEmpty(name, value);
}

export function normalizeSagaTurnSourceEvent(source: SagaTurnSourceEvent): SagaTurnSourceEvent {
  requireNonEmpty('type', source.type);
  requireNonEmpty('partitionId', source.partitionId);
  requireNonEmpty('streamId', source.streamId);
  requireNonEmpty('commitId', source.commitId);
  requireNonEmpty('eventId', source.eventId);
  validateOptionalString('aggregateType', source.aggregateType);
  validateOptionalString('aggregateId', source.aggregateId);
  validateOptionalString('correlationId', source.correlationId);
  validateOptionalString('causationId', source.causationId);
  if (!Number.isSafeInteger(source.eventIndex) || source.eventIndex < 0) {
    throw new SagaTurnPermanentError('invalid_source_event', 'eventIndex must be a zero-based safe integer');
  }
  if (source.sequence !== undefined && (!Number.isSafeInteger(source.sequence) || source.sequence < 0)) {
    throw new SagaTurnPermanentError('invalid_source_event', 'sequence must be a non-negative safe integer');
  }
  const timestamp = new Date(source.createDateTime);
  if (Number.isNaN(timestamp.getTime())) throw new SagaTurnPermanentError('invalid_source_event', 'createDateTime must be a valid timestamp');
  try {
    validateBusinessState(source.payload);
    if (source.metadata !== undefined) validateBusinessState(source.metadata);
  } catch (error) {
    throw new SagaTurnPermanentError('invalid_source_event', 'Source payload and metadata must be JSON-safe', {}, error);
  }
  return { ...source, createDateTime: timestamp.toISOString() };
}
