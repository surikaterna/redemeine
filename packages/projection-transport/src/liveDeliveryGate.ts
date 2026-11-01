import { isDeepStrictEqual } from 'node:util';
import { validateCompleteCommitRange, type ProjectionCompleteCommitRangeReader,
  type ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { decodeTapewormProjectionCommit } from './tapewormDecoder';

export interface LiveRabbitDelivery {
  readonly content: Buffer;
  readonly fields: { readonly deliveryTag: number; readonly redelivered: boolean };
  readonly properties: { readonly messageId?: string; readonly headers?: Readonly<Record<string, unknown>> };
}

export interface LiveDeliveryGate {
  readonly sourceScopeDigest: string;
  verify(delivery: LiveRabbitDelivery): Promise<ProjectionSourceCommit>;
}

export interface LiveDeliveryScope {
  readonly sourceScopeDigest: string;
  readonly collection: string;
  readonly partitionId: string;
  readonly tenant?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createLiveDeliveryGate(inputScope: LiveDeliveryScope, reader: ProjectionCompleteCommitRangeReader,
  maxBytes: number): LiveDeliveryGate {
  const scope = Object.freeze({ ...inputScope });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !scope.sourceScopeDigest || !scope.collection || !scope.partitionId) {
    throw new Error('invalid_live_delivery_scope');
  }
  return { sourceScopeDigest: scope.sourceScopeDigest, async verify(delivery) {
    if (delivery.content.byteLength > maxBytes) throw new Error('live_payload_capacity');
    const wire: unknown = JSON.parse(delivery.content.toString('utf8'));
    const headers = delivery.properties.headers;
    if (!record(wire) || wire.partitionId !== scope.partitionId || !headers
      || headers.collection !== scope.collection || headers.partitionId !== scope.partitionId
      || headers.streamId !== wire.streamId || headers.tenant !== scope.tenant) throw new Error('live_wire_scope_mismatch');
    const decoded = decodeTapewormProjectionCommit(wire, delivery.properties.messageId);
    if (decoded.status !== 'valid') throw new Error('invalid_live_wire');
    const commit = decoded.commit;
    const request = { sourceId: commit.streamId, afterSequence: commit.commitSequence === 0 ? null : commit.commitSequence - 1,
      throughSequence: commit.commitSequence, maxCommits: 1, maxBytes };
    const page = await reader.readCompleteRange(request);
    if (page.status !== 'complete' || !validateCompleteCommitRange(request, page).valid
      || !isDeepStrictEqual(page.commits[0]?.commit, commit)) throw new Error('live_authoritative_commit_mismatch');
    return commit;
  } };
}
