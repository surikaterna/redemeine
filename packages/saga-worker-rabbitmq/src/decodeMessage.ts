import { SagaTurnPermanentError, type SagaTurnSourceEvent, validateBusinessState } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';
import type { SagaRabbitSourceScope, SagaRabbitWorkerLimits } from './contracts';

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

function decodeJson(content: Buffer, maxBodyBytes: number): unknown {
  if (content.length > maxBodyBytes) throw invalid('Rabbit message body exceeds maxBodyBytes');
  try {
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw invalid('Rabbit message body must be valid JSON', error);
  }
}

function decodeCommit(content: Buffer, limits: SagaRabbitWorkerLimits): DecodedCommit {
  const value = decodeJson(content, limits.maxBodyBytes);
  const body = requireRecord(value, 'Rabbit commit');
  if (!Array.isArray(body.events) || body.events.length === 0) throw invalid('events must be a non-empty array');
  if (body.events.length > limits.maxEvents) throw invalid('Rabbit commit event count exceeds maxEvents');
  try {
    validateBusinessState(value);
  } catch (error) {
    throw invalid('Rabbit commit must be JSON-safe', error);
  }
  const createDateTime = requireString(body, 'createDateTime');
  if (Number.isNaN(new Date(createDateTime).getTime())) throw invalid('createDateTime must be a valid timestamp');
  return {
    id: requireString(body, 'id'),
    partitionId: requireString(body, 'partitionId'),
    streamId: requireString(body, 'streamId'),
    commitSequence: requireInteger(body, 'commitSequence'),
    createDateTime: new Date(createDateTime).toISOString(),
    events: body.events.map((event) => requireRecord(event, 'Rabbit commit event'))
  };
}

function validateProperties(message: ConsumeMessage, commit: DecodedCommit, scope: SagaRabbitSourceScope): void {
  const contentType: unknown = message.properties.contentType;
  const messageId: unknown = message.properties.messageId;
  const headers: unknown = message.properties.headers;
  if (contentType !== 'application/json') throw invalid('contentType must be application/json');
  if (typeof messageId !== 'string' || messageId.length === 0) throw invalid('messageId must be a non-empty string');
  if (messageId !== commit.id) throw invalid('messageId must equal commit id');
  const record = requireRecord(headers, 'Rabbit headers');
  const partitionId = requireString(record, 'partitionId', 'Rabbit partitionId header');
  const streamId = requireString(record, 'streamId', 'Rabbit streamId header');
  const collection = requireString(record, 'collection', 'Rabbit collection header');
  if (partitionId !== commit.partitionId || streamId !== commit.streamId) {
    throw invalid('Rabbit partitionId and streamId headers must match the commit');
  }
  if (collection !== scope.collection) throw invalid('Rabbit collection header is outside configured source scope');
  if (!scope.partitions.includes(partitionId)) throw invalid('Rabbit partition is outside configured source scope');
}

function validateEventOrder(events: readonly Record<string, unknown>[]): void {
  let previousVersion: number | undefined;
  for (const event of events) {
    requireString(event, 'id', 'event id');
    requireString(event, 'type', 'event type');
    const version = requireInteger(event, 'version', 'event version');
    if (previousVersion !== undefined && version !== previousVersion + 1) {
      throw invalid('event versions must increase contiguously');
    }
    previousVersion = version;
  }
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

export function decodeSagaRabbitMessage(
  message: ConsumeMessage,
  scope: SagaRabbitSourceScope,
  limits: SagaRabbitWorkerLimits
): readonly SagaTurnSourceEvent[] {
  const commit = decodeCommit(message.content, limits);
  validateProperties(message, commit, scope);
  validateEventOrder(commit.events);
  return commit.events.map((event, index) => sourceEvent(commit, event, index));
}
