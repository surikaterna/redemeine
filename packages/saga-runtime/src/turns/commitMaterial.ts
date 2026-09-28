import { isDeepStrictEqual } from 'node:util';
import { validateBusinessState } from '../businessStateValidation';
import type { SagaTurnAppendRequest, SagaTurnStoredCommit } from './contracts';
import { SagaTurnIntegrityError } from './errors';

export function assertSagaTurnIntentBudget(events: readonly { readonly type: string; readonly payload: unknown }[]): void {
  if (events.length === 0 || events.length > 256) throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Turn event count exceeds 256');
  for (const event of events) {
    if (event.type !== 'saga.intent_recorded.event') continue;
    if (event.payload === null || typeof event.payload !== 'object' || !('intent' in event.payload)) {
      throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Missing authoritative wire intent');
    }
    try {
      validateBusinessState(event.payload.intent, { maxBytes: 65536, maxDepth: 16 });
    } catch (cause) {
      throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Wire intent exceeds its independent 64 KiB budget', {}, cause);
    }
  }
}

// Complete turn material may contain an 8 MiB business state plus envelope/observation.
export function assertSagaTurnJsonSafe(value: unknown): void {
  try {
    validateBusinessState(value, { maxBytes: 24 * 1024 * 1024 });
  } catch (cause) {
    throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Turn material is not bounded JSON-safe data', {}, cause);
  }
}

export function assertEquivalentSagaCommit(
  stored: SagaTurnStoredCommit,
  request: SagaTurnAppendRequest,
  partitionId: string,
  firstEventVersion: number
): void {
  // Inspect the original request before optional fields are omitted from the wire envelope.
  assertSagaTurnJsonSafe(request);
  assertSagaTurnIntentBudget(request.events);
  const expected = {
    partitionId,
    streamId: request.streamId,
    commitId: request.commitId,
    commitSequence: stored.commitSequence,
    identity: request.identity,
    events: request.events.map((event, index) => ({
      id: `${request.commitId}:event:${index}`,
      type: event.type,
      version: firstEventVersion + index,
      payload: event.payload,
      ...(event.headers === undefined ? {} : { headers: event.headers }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata })
    }))
  };
  assertSagaTurnJsonSafe(stored);
  assertSagaTurnJsonSafe(expected);
  if (!isDeepStrictEqual(stored, expected)) {
    throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Deterministic turn ID has incompatible stored content', {
      commitId: request.commitId,
      streamId: request.streamId,
      expectedIdentity: request.identity,
      actualIdentity: stored.identity
    });
  }
}
