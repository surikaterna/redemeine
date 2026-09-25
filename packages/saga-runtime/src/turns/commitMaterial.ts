import { isDeepStrictEqual } from 'node:util';
import { validateBusinessState } from '../businessStateValidation';
import type { SagaTurnAppendRequest, SagaTurnStoredCommit } from './contracts';
import { SagaTurnIntegrityError } from './errors';

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
