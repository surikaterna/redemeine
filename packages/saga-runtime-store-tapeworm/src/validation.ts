import { SagaTurnIntegrityError, type SagaTurnIdentity, type SagaTurnStoredCommit } from '@redemeine/saga-runtime';
import type { ICommit } from 'tapeworm';
import type { TapewormSagaEvent } from './contracts';

export interface ValidatedTapewormStream {
  readonly commits: readonly ICommit<TapewormSagaEvent>[];
  readonly events: readonly unknown[];
  readonly nextCommitSequence: number;
  readonly nextEventVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): SagaTurnIntegrityError {
  return new SagaTurnIntegrityError('invalid_tapeworm_stream', message);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`);
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, expected: number, label: string): void {
  const value = record[key];
  if (!Number.isSafeInteger(value) || value !== expected) throw invalid(`${label} must equal ${expected}`);
}

function eventFromUnknown(value: unknown, expectedVersion: number): { readonly stored: unknown; readonly tapeworm: TapewormSagaEvent } {
  if (!isRecord(value)) throw invalid('Tapeworm event must be an object');
  if (Object.keys(value).some((key) => !['id', 'type', 'version', 'payload', 'headers', 'metadata'].includes(key))) {
    throw invalid('Tapeworm event has unsupported fields');
  }
  requireString(value, 'id', 'Tapeworm event id');
  const type = requireString(value, 'type', 'Tapeworm event type');
  if (!type.endsWith('.event')) throw invalid('Tapeworm event type must end in .event');
  if (!Object.hasOwn(value, 'payload')) throw invalid('Tapeworm event payload is required');
  requireInteger(value, 'version', expectedVersion, 'Tapeworm event version');
  const headers = value.headers;
  const metadata = value.metadata;
  if (headers !== undefined && !isRecord(headers)) throw invalid('Tapeworm event headers must be an object');
  if (metadata !== undefined && !isRecord(metadata)) throw invalid('Tapeworm event metadata must be an object');
  const stored = {
    type,
    payload: value.payload,
    id: requireString(value, 'id', 'Tapeworm event id'),
    ...(headers === undefined ? {} : { headers }),
    ...(metadata === undefined ? {} : { metadata })
  };
  return { stored, tapeworm: { ...stored, version: expectedVersion } };
}

function commitFromUnknown(
  value: unknown,
  partitionId: string,
  streamId: string,
  expectedSequence: number,
  firstEventVersion: number
): { readonly commit: ICommit<TapewormSagaEvent>; readonly events: readonly unknown[] } {
  if (!isRecord(value)) throw invalid('Tapeworm commit must be an object');
  if (Object.keys(value).some((key) => !['id', 'partitionId', 'streamId', 'commitSequence', 'events', 'sagaTurnIdentity'].includes(key))) {
    throw invalid('Tapeworm commit has unsupported fields');
  }
  requireString(value, 'id', 'Tapeworm commit id');
  if (value.partitionId !== partitionId) throw invalid('Tapeworm commit partitionId does not match configured partition');
  if (value.streamId !== streamId) throw invalid('Tapeworm commit streamId does not match requested stream');
  requireInteger(value, 'commitSequence', expectedSequence, 'Tapeworm commit sequence');
  if (!Array.isArray(value.events) || value.events.length === 0) throw invalid('Tapeworm commit events must be non-empty');
  const validatedEvents = value.events.map((event, index) => eventFromUnknown(event, firstEventVersion + index));
  for (let index = 0; index < validatedEvents.length; index += 1) {
    if (validatedEvents[index]?.tapeworm.id !== `${value.id}:event:${index}`) throw invalid('Tapeworm event ID does not match commit position');
  }
  const commit: ICommit<TapewormSagaEvent> = {
    id: requireString(value, 'id', 'Tapeworm commit id'),
    partitionId,
    streamId,
    commitSequence: expectedSequence,
    events: validatedEvents.map(({ tapeworm }) => tapeworm),
    ...(value.sagaTurnIdentity === undefined ? {} : { sagaTurnIdentity: value.sagaTurnIdentity })
  };
  return { commit, events: validatedEvents.map(({ stored }) => stored) };
}

export function validateTapewormStream(value: unknown, partitionId: string, streamId: string): ValidatedTapewormStream {
  if (value === undefined || value === null) return { commits: [], events: [], nextCommitSequence: 0, nextEventVersion: 0 };
  if (!Array.isArray(value)) throw invalid('Tapeworm queryStream result must be an array');
  const commits: ICommit<TapewormSagaEvent>[] = [];
  const events: unknown[] = [];
  let eventVersion = 0;
  for (let sequence = 0; sequence < value.length; sequence += 1) {
    const validated = commitFromUnknown(value[sequence], partitionId, streamId, sequence, eventVersion);
    commits.push(validated.commit);
    events.push(...validated.events);
    eventVersion += validated.events.length;
  }
  return { commits, events, nextCommitSequence: commits.length, nextEventVersion: eventVersion };
}

function identityFromUnknown(value: unknown): SagaTurnIdentity {
  if (!isRecord(value)) throw invalid('Stored saga turn identity must be an object');
  if (Object.keys(value).length !== 4 || Object.keys(value).some((key) => !['sourceTriggerId', 'sagaKey', 'instanceId', 'routeId'].includes(key))) {
    throw invalid('Stored saga turn identity has unsupported fields');
  }
  return {
    sourceTriggerId: requireString(value, 'sourceTriggerId', 'Stored sourceTriggerId'),
    sagaKey: requireString(value, 'sagaKey', 'Stored sagaKey'),
    instanceId: requireString(value, 'instanceId', 'Stored instanceId'),
    routeId: requireString(value, 'routeId', 'Stored routeId')
  };
}

export function storedCommitFromTapeworm(value: ICommit<TapewormSagaEvent>): SagaTurnStoredCommit {
  const events = value.events.map((event) => {
    if (!Number.isSafeInteger(event.version) || event.version === undefined || event.version < 0) throw invalid('Tapeworm event version is invalid');
    return {
      id: event.id,
      type: event.type,
      version: event.version,
      payload: event.payload,
      ...(event.headers === undefined ? {} : { headers: event.headers }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata })
    };
  });
  return {
    partitionId: value.partitionId,
    streamId: value.streamId,
    commitId: value.id,
    commitSequence: value.commitSequence,
    identity: identityFromUnknown(value.sagaTurnIdentity),
    events
  };
}
