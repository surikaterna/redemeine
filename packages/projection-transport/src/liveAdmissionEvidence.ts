import type {
  FirstLiveEvidence, LiveDeliveryIdentity, LiveFeedSession, LiveSourceOrderPort, LiveSourcePosition, ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';

function assertWitness(evidence: FirstLiveEvidence, session: LiveFeedSession,
  commit: ProjectionSourceCommit, delivery: LiveDeliveryIdentity): void {
  evidence.assertCurrent();
  const floor = evidence.position;
  const kind = session.start.mode === 'LIVE_FROM_BOUNDARY' ? 'ordered_first_live_delivery' : 'broker_first_retained_delivery';
  if (evidence.kind !== kind || evidence.start !== session.start
    || evidence.delivery.sessionRef !== session.sessionRef || evidence.delivery.deliveryTag !== delivery.deliveryTag
    || evidence.delivery.messageId !== delivery.messageId || evidence.delivery.redelivered !== delivery.redelivered
    || floor.epoch !== session.start.epoch || floor.registryDigest !== session.start.registryDigest
    || floor.sourceId !== commit.streamId || floor.firstCommitId !== commit.commitId
    || floor.firstSequence !== commit.commitSequence || floor.coveredThrough !== null) {
    throw new Error('mismatched_first_live_evidence');
  }
}

export async function admitLiveDelivery(order: LiveSourceOrderPort, session: LiveFeedSession,
  commit: ProjectionSourceCommit, delivery: LiveDeliveryIdentity): Promise<LiveSourcePosition> {
  session.assertCurrent();
  if (delivery.sessionRef !== session.sessionRef || delivery.messageId !== commit.commitId) {
    throw new Error('mismatched_live_delivery');
  }
  const stored = await order.load(commit.streamId, session.start.epoch);
  session.assertCurrent();
  if (stored) {
    if (stored.registryDigest !== session.start.registryDigest || stored.sourceId !== commit.streamId
      || stored.epoch !== session.start.epoch || commit.commitSequence < stored.firstSequence
      || (commit.commitSequence === stored.firstSequence && commit.commitId !== stored.firstCommitId)) {
      throw new Error('live_continuity_violation');
    }
    return stored;
  }
  const result = await session.certifyFirst(commit, delivery);
  session.assertCurrent();
  if (result.status !== 'qualified') throw new Error('unproven_first_live_delivery');
  assertWitness(result.value, session, commit, delivery);
  const evidence: FirstLiveEvidence = Object.freeze({
    ...result.value, delivery: Object.freeze({ ...delivery }),
    position: Object.freeze({ ...result.value.position }),
    assertCurrent: () => { session.assertCurrent(); result.value.assertCurrent(); }
  });
  return order.admitFirst(evidence);
}
