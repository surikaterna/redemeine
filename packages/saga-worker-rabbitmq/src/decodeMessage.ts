import { SagaTurnPermanentError, type SagaTurnSourceEvent, validateBusinessState } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';

interface DecodedCommit {
  readonly id: string;
  readonly partitionId: string;
  readonly streamId: string;
  readonly commitSequence: number;
  readonly createDateTime: string;
  readonly events: readonly Record<string, unknown>[];
}

function invalid(message: string, cause?: unknown): SagaTurnPermanentError {
  return new SagaTurnPermanentError('invalid_rabbit_message', message, {}, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`);
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, label = key): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label = key): string | undefined {
  if (record[key] === undefined) return undefined;
  return requireString(record, key, label);
}

function decodeJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw invalid('Rabbit message body must be valid JSON', error);
  }
}

function decodeCommit(content: Buffer): DecodedCommit {
  const value = decodeJson(content);
  try {
    validateBusinessState(value);
  } catch (error) {
    throw invalid('Rabbit commit must be JSON-safe', error);
  }
  const body = requireRecord(value, 'Rabbit commit');
  const createDateTime = requireString(body, 'createDateTime');
  if (Number.isNaN(new Date(createDateTime).getTime())) throw invalid('createDateTime must be a valid timestamp');
  if (!Array.isArray(body.events) || body.events.length === 0) throw invalid('events must be a non-empty array');
  return {
    id: requireString(body, 'id'),
    partitionId: requireString(body, 'partitionId'),
    streamId: requireString(body, 'streamId'),
    commitSequence: requireInteger(body, 'commitSequence'),
    createDateTime: new Date(createDateTime).toISOString(),
    events: body.events.map((event) => requireRecord(event, 'Rabbit commit event'))
  };
}

function validateProperties(message: ConsumeMessage, commit: DecodedCommit): void {
  const contentType: unknown = message.properties.contentType;
  const messageId: unknown = message.properties.messageId;
  const headers: unknown = message.properties.headers;
  if (contentType !== 'application/json') throw invalid('contentType must be application/json');
  if (messageId !== undefined && messageId !== commit.id) throw invalid('messageId must equal commit id');
  const record = requireRecord(headers, 'Rabbit headers');
  if (record.partitionId !== commit.partitionId || record.streamId !== commit.streamId) {
    throw invalid('Rabbit partitionId and streamId headers must match the commit');
  }
  requireString(record, 'collection', 'Rabbit collection header');
}

function sourceEvent(commit: DecodedCommit, event: Record<string, unknown>, eventIndex: number): SagaTurnSourceEvent {
  const metadataValue = event.metadata;
  if (metadataValue !== undefined && !isRecord(metadataValue)) throw invalid('event metadata must be an object');
  const metadata = metadataValue;
  const correlationId = metadata ? optionalString(metadata, 'correlationId', 'event metadata correlationId') : undefined;
  const causationId = metadata ? optionalString(metadata, 'causationId', 'event metadata causationId') : undefined;
  if (!Object.hasOwn(event, 'payload')) throw invalid('event payload is required');
  return {
    type: requireString(event, 'type', 'event type'),
    payload: event.payload,
    partitionId: commit.partitionId,
    streamId: commit.streamId,
    commitId: commit.id,
    eventIndex,
    eventId: requireString(event, 'id', 'event id'),
    createDateTime: commit.createDateTime,
    sequence: requireInteger(event, 'version', 'event version'),
    ...(optionalString(event, 'aggregateType', 'event aggregateType') === undefined ? {} : { aggregateType: requireString(event, 'aggregateType') }),
    ...(optionalString(event, 'aggregateId', 'event aggregateId') === undefined ? {} : { aggregateId: requireString(event, 'aggregateId') }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(causationId === undefined ? {} : { causationId }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

export function decodeSagaRabbitMessage(message: ConsumeMessage): readonly SagaTurnSourceEvent[] {
  const commit = decodeCommit(message.content);
  validateProperties(message, commit);
  return commit.events.map((event, index) => sourceEvent(commit, event, index));
}
