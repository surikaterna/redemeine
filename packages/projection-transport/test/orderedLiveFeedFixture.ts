import type {
  LiveDeliveryIdentity, LiveFeedEvidencePort, LiveFeedSession, LiveStartRecord, ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';

export const liveStart: LiveStartRecord = Object.freeze({ mode: 'LIVE_FROM_BOUNDARY', epoch: 'epoch',
  queueName: 'rdm.projection.commits', vhost: '/', bindingRef: 'binding', registryDigest: 'registry', generation: 'generation',
  sourceScopeDigest: 'scope', nativeStartRef: 'native-T', provisioningRef: 'fresh-output-and-queue',
  publisherRef: 'serial-owner', orderedFeedQualificationRef: 'model:no-skip-confirm-checkpoint' });

/** Test-only history model, not a production certifier or a readiness Boolean. */
export class OrderedLiveFeedFixture implements LiveFeedEvidencePort {
  private readonly published: ProjectionSourceCommit[] = [];
  private readonly queue: ProjectionSourceCommit[] = [];
  private checkpoint = liveStart.nativeStartRef;
  private pendingPublication: ProjectionSourceCommit | undefined;
  private activeSession: LiveFeedSession | undefined;
  private issued: LiveDeliveryIdentity | undefined;
  private tag = 0;
  private queueExists = true;

  expireNativeResume(): void { this.checkpoint = ''; this.activeSession?.invalidate(); }

  loseQueue(): void {
    this.queue.length = 0;
    this.queueExists = false;
    this.activeSession?.invalidate();
  }

  publish(commit: ProjectionSourceCommit): void {
    if (this.pendingPublication) throw new Error('checkpoint must follow confirm before next publication');
    const prior = this.published.filter((item) => item.streamId === commit.streamId).at(-1);
    if (prior && commit.commitSequence !== prior.commitSequence + 1) throw new Error('noncontiguous source append');
    this.pendingPublication = commit;
  }

  confirmIntendedQueue(): void {
    if (!this.pendingPublication) throw new Error('no publication');
    this.queue.push(this.pendingPublication);
    this.published.push(this.pendingPublication);
  }

  persistNativeCheckpoint(): void {
    if (!this.pendingPublication || this.queue.at(-1) !== this.pendingPublication) throw new Error('unconfirmed publication');
    this.checkpoint = `native:${this.pendingPublication.commitId}`;
    this.pendingPublication = undefined;
  }

  append(commit: ProjectionSourceCommit): void {
    this.publish(commit);
    this.confirmIntendedQueue();
    this.persistNativeCheckpoint();
  }

  delivery(redelivered = false): LiveDeliveryIdentity {
    const commit = this.queue[0];
    if (!commit || !this.activeSession) throw new Error('no queued commit or session');
    this.issued = { sessionRef: this.activeSession.sessionRef, deliveryTag: ++this.tag,
      messageId: commit.commitId, redelivered };
    return this.issued;
  }

  async openSession(start: LiveStartRecord, channel: Parameters<LiveFeedEvidencePort['openSession']>[1]) {
    if (start.mode !== 'LIVE_FROM_BOUNDARY' || JSON.stringify(start) !== JSON.stringify(liveStart) || channel.queueName !== liveStart.queueName
      || channel.prefetch !== 1 || !channel.exclusive || !this.checkpoint || !this.queueExists || this.pendingPublication || this.activeSession) {
      return { status: 'unproven' as const, reason: 'model_continuity_unproven' };
    }
    let active = true;
    let reservation: LiveDeliveryIdentity | undefined;
    const assertCurrent = () => { if (!active) throw new Error('expired session'); };
    const session: LiveFeedSession = {
      sessionRef: channel.sessionRef, start,
      assertCurrent,
      reserve: (delivery) => {
        assertCurrent();
        if (reservation || JSON.stringify(delivery) !== JSON.stringify(this.issued)
          || delivery.sessionRef !== channel.sessionRef) throw new Error('unordered delivery');
        reservation = delivery;
      },
      certifyFirst: async (commit, delivery) => {
        assertCurrent();
        const first = this.published.find((item) => item.streamId === commit.streamId);
        if (reservation !== delivery || delivery.redelivered || first !== this.queue[0]
          || first?.commitId !== commit.commitId || first.commitSequence !== commit.commitSequence) {
          return { status: 'unproven', reason: 'not_preserved_first_position' };
        }
        return { status: 'qualified', value: Object.freeze({ kind: 'ordered_first_live_delivery', start, delivery,
          position: Object.freeze({ epoch: start.epoch, registryDigest: start.registryDigest, sourceId: commit.streamId,
            firstSequence: first.commitSequence, firstCommitId: first.commitId, coveredThrough: null }),
          assertCurrent: () => { assertCurrent(); if (reservation !== delivery) throw new Error('expired reservation'); }
        }) };
      },
      settled: (delivery) => {
        assertCurrent();
        if (reservation !== delivery) throw new Error('wrong settlement');
        this.queue.shift();
        reservation = undefined;
        this.issued = undefined;
      },
      invalidate: () => { active = false; reservation = undefined;
        if (this.activeSession === session) this.activeSession = undefined; }
    };
    this.activeSession = session;
    return { status: 'qualified' as const, value: session };
  }
}
