import { expect } from '@jest/globals';
import type { SagaTurnAppendRequest } from '@redemeine/saga-runtime';
import type { ICommit } from 'tapeworm';
import { decodeIntent } from '../../saga-runtime/src/intentWire';
import { intentRegistry } from './intentFixtures';

export function assertPhysicalTurn(commit: ICommit, request: SagaTurnAppendRequest,
  partitionId: string, firstVersion: number): void {
  expect(commit).toMatchObject({ id: request.commitId, partitionId,
    streamId: request.streamId, sagaTurnIdentity: request.identity,
    commitSequence: request.expectedNextCommitSequence });
  expect(commit.events).toEqual(request.events.map((event, index) => ({
    id: `${request.commitId}:event:${index}`, type: event.type, payload: event.payload,
    version: firstVersion + index,
    ...(event.headers === undefined ? {} : { headers: event.headers }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata })
  })));
  const intents = commit.events.filter(event => event.type === 'saga.intent_recorded.event');
  expect(intents).toHaveLength(6);
  for (const [ordinal, event] of intents.entries()) {
    if (typeof event.payload !== 'object' || event.payload === null || !('intent' in event.payload)) {
      throw new Error('missing v1 wire intent');
    }
    const intent = decodeIntent(event.payload.intent, intentRegistry);
    expect(intent.origin.ordinal).toBe(ordinal);
    expect(intent.origin.sourceId).toBe(request.identity.sourceTriggerId);
    expect(intent.origin.routeId).toBe(request.identity.routeId);
    expect(intent.instanceId).toBe(request.streamId);
  }
}
