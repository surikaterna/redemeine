import { isDeepStrictEqual } from 'node:util';
import type { FirstLiveEvidence, LiveDeliveryIdentity, LiveEvidenceResult, LiveFeedSession,
  LiveNativeStartRecord, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';

export interface SessionHistory {
  issued(): LiveDeliveryIdentity | undefined;
  first(sourceId: string): ProjectionSourceCommit | undefined;
  front(): ProjectionSourceCommit | undefined;
  settle(): void;
}

export class ModelSession implements LiveFeedSession {
  private active = true;
  private reservation: LiveDeliveryIdentity | undefined;

  constructor(readonly start: LiveNativeStartRecord, readonly sessionRef: string, private readonly history: SessionHistory) {}

  assertCurrent(): void {
    if (!this.active) throw new Error('model:expired_session');
  }

  reserve(delivery: LiveDeliveryIdentity): void {
    this.assertCurrent();
    if (this.reservation || delivery.sessionRef !== this.sessionRef || !isDeepStrictEqual(delivery, this.history.issued())) {
      throw new Error('model:unordered_delivery');
    }
    this.reservation = delivery;
  }

  async certifyFirst(commit: ProjectionSourceCommit, delivery: LiveDeliveryIdentity): Promise<LiveEvidenceResult<FirstLiveEvidence>> {
    this.assertCurrent();
    const first = this.history.first(commit.streamId);
    if (this.reservation !== delivery || delivery.redelivered || first !== this.history.front()
      || !isDeepStrictEqual(first, commit)) return { status: 'unproven', reason: 'model:first_not_preserved' };
    const start = this.start;
    return { status: 'qualified', value: Object.freeze({ kind: 'ordered_first_live_delivery', start, delivery,
      position: Object.freeze({ epoch: start.epoch, registryDigest: start.registryDigest, sourceId: commit.streamId,
        firstSequence: commit.commitSequence, firstCommitId: commit.commitId, coveredThrough: null }),
      assertCurrent: () => {
        this.assertCurrent();
        if (this.reservation !== delivery) throw new Error('model:expired_reservation');
      } }) };
  }

  settled(delivery: LiveDeliveryIdentity): void {
    this.assertCurrent();
    if (this.reservation !== delivery) throw new Error('model:wrong_settlement');
    this.history.settle();
    this.reservation = undefined;
  }

  invalidate(): void { this.active = false; this.reservation = undefined; }
}
