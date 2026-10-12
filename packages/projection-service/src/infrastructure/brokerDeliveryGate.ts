import type { LiveSourceOrderPort, ProjectionCompleteCommitRangeReader } from '@redemeine/projection-runtime-core';
import { createLiveDeliveryGate, decodeTapewormProjectionCommit, type LiveDeliveryGate, type LiveDeliveryScope } from '@redemeine/projection-transport';
import { BrokerRefusal, object } from './brokerSchema';

export function brokerDeliveryGate(inputScope: LiveDeliveryScope, reader: ProjectionCompleteCommitRangeReader, maxBytes: number,
  order: LiveSourceOrderPort, epoch: string, assertCurrent: () => void): LiveDeliveryGate {
  const scope = Object.freeze({ ...inputScope });
  const authoritative = createLiveDeliveryGate(scope, reader, maxBytes);
  return { sourceScopeDigest: scope.sourceScopeDigest, async verify(delivery) {
    assertCurrent();
    if (delivery.content.byteLength > maxBytes) throw new BrokerRefusal('live_payload_capacity');
    const candidate: unknown = JSON.parse(delivery.content.toString('utf8'));
    const wire = object(candidate); const headers = delivery.properties.headers;
    const decoded = decodeTapewormProjectionCommit(wire, delivery.properties.messageId);
    if (decoded.status !== 'valid' || wire.partitionId !== scope.partitionId || headers?.partitionId !== scope.partitionId
      || headers.collection !== scope.collection || headers.streamId !== decoded.commit.streamId || headers.tenant !== scope.tenant) {
      throw new BrokerRefusal('live_wire_scope_mismatch');
    }
    const floor = await order.load(decoded.commit.streamId, epoch);
    assertCurrent();
    // Reject resumed pre-binding publication before even reading the excluded source prefix.
    if (floor && decoded.commit.commitSequence < floor.firstSequence) throw new BrokerRefusal('live_continuity_violation');
    const commit = await authoritative.verify(delivery);
    assertCurrent();
    return commit;
  } };
}
