import { BSON, ObjectId, UUID } from 'bson';
import { validateBusinessState } from '../businessStateValidation';
import type { SagaTurnAppendRequest } from './contracts';
import { assertSagaTurnIntentBudget, assertSagaTurnJsonSafe } from './commitMaterial';
import { SagaTurnIntegrityError } from './errors';

export const SAGA_TURN_MAX_EVENTS = 256;
export const SAGA_TURN_MAX_EVENT_BSON_BYTES = 10 * 1024 * 1024;
export const SAGA_TURN_MAX_COMMIT_BSON_BYTES = 12 * 1024 * 1024;

function invalid(message: string, cause?: unknown): never {
  throw new SagaTurnIntegrityError('incompatible_turn_commit', message, {}, cause);
}

function assertSerializable(value: object): void {
  try {
    BSON.serialize(value);
  } catch (cause) {
    throw new SagaTurnIntegrityError('invalid_tapeworm_stream', 'Saga turn cannot be serialized as BSON', {}, cause);
  }
}

export function assertSagaTurnPreappendBudget(request: SagaTurnAppendRequest, partitionId: string,
  firstEventVersion: number): number {
  if (typeof partitionId !== 'string' || !partitionId || !Number.isSafeInteger(firstEventVersion) || firstEventVersion < 0) {
    return invalid('Invalid physical saga commit boundary');
  }
  assertSagaTurnJsonSafe(request);
  assertSagaTurnIntentBudget(request.events);
  if (request.events.length > SAGA_TURN_MAX_EVENTS || firstEventVersion + request.events.length > Number.MAX_SAFE_INTEGER) {
    return invalid('Saga turn event count or version exceeds its physical limit');
  }
  for (const event of request.events) {
    if (event.type !== 'saga.business_state_recorded.event') continue;
    if (!event.payload || typeof event.payload !== 'object' || !('state' in event.payload)) return invalid('Missing saga business state');
    try {
      validateBusinessState(event.payload.state, { maxBytes: 8 * 1024 * 1024 });
    } catch (cause) { return invalid('Saga business state exceeds its 8 MiB budget', cause); }
  }
  const events = request.events.map((event, index) => ({
    id: `${request.commitId}:event:${index}`, type: event.type, version: firstEventVersion + index,
    payload: event.payload,
    ...(event.headers === undefined ? {} : { headers: event.headers }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata })
  }));
  for (const event of events) {
    if (BSON.calculateObjectSize(event) > SAGA_TURN_MAX_EVENT_BSON_BYTES) return invalid('Saga event exceeds the BSON byte limit');
  }
  const physical = { id: request.commitId, partitionId, streamId: request.streamId,
    commitSequence: request.expectedNextCommitSequence, sagaTurnIdentity: request.identity, events,
    _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
    isDispatched: false, createDateTime: new Date(0) };
  const bytes = BSON.calculateObjectSize(physical);
  if (bytes > SAGA_TURN_MAX_COMMIT_BSON_BYTES) return invalid('Saga complete commit exceeds the BSON byte limit');
  assertSerializable(physical);
  return bytes;
}
