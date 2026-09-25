import { isDeepStrictEqual } from 'node:util';
import { validateBusinessState } from '../businessStateValidation';
import type { SagaTurnAppendRequest, SagaTurnStoredCommit } from './contracts';
import { SagaTurnIntegrityError } from './errors';

export function assertEquivalentSagaCommit(
  stored: SagaTurnStoredCommit,
  request: SagaTurnAppendRequest,
  partitionId: string,
  firstEventVersion: number
): void {
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
  try {
    validateBusinessState(stored);
    validateBusinessState(expected);
  } catch (cause) {
    throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Turn material is not bounded JSON-safe data', { commitId: request.commitId }, cause);
  }
  if (!isDeepStrictEqual(stored, expected)) {
    throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Deterministic turn ID has incompatible stored content', {
      commitId: request.commitId,
      streamId: request.streamId,
      expectedIdentity: request.identity,
      actualIdentity: stored.identity
    });
  }
}
