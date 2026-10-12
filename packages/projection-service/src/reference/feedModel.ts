import { isDeepStrictEqual } from 'node:util';
import { validateProjectionSourceCommit, type LiveDeliveryIdentity, type LiveEvidenceResult,
  type LiveFeedEvidencePort, type LiveFeedSession, type LiveStartRecord, type LiveNativeStartRecord, type ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import type { LiveRabbitDelivery } from '@redemeine/projection-transport';
import { ModelSession } from './modelSession';
import { modelScope } from './modelIdentity';
import { copyCommit } from './copyCommit';

/** Bounded in-memory publisher/queue history, never a production evidence provider. */
export class OrderedFeedModel implements LiveFeedEvidencePort {
  private readonly published: ProjectionSourceCommit[] = [];
  private readonly queue: ProjectionSourceCommit[] = [];
  private pending: { commit: ProjectionSourceCommit; confirmed: boolean } | undefined;
  private checkpoint: string;
  private session: ModelSession | undefined;
  private issued: { identity: LiveDeliveryIdentity; raw: LiveRabbitDelivery; acked: boolean } | undefined;
  private tag = 0;
  private intact = true;

  constructor(private readonly expected: LiveNativeStartRecord, private readonly trace: string[]) {
    this.checkpoint = expected.nativeStartRef;
  }

  publish(commit: ProjectionSourceCommit): void {
    if (!this.intact || this.pending || this.published.length >= 32 || !validateProjectionSourceCommit(commit).valid) {
      throw new Error('model:publication_refused');
    }
    const prior = [...this.published].reverse().find((item) => item.streamId === commit.streamId);
    if (prior && commit.commitSequence !== prior.commitSequence + 1) throw new Error('model:noncontiguous_publication');
    if (this.published.some((item) => item.commitId === commit.commitId)) throw new Error('model:duplicate_publication');
    this.pending = { commit: copyCommit(commit), confirmed: false };
    this.trace.push(`model:publish:${commit.commitSequence}`);
  }

  confirmIntendedQueue(): void {
    if (!this.intact || !this.pending || this.pending.confirmed) throw new Error('model:confirm_refused');
    this.queue.push(this.pending.commit);
    this.published.push(this.pending.commit);
    this.pending.confirmed = true;
    this.trace.push(`model:confirm:${this.pending.commit.commitSequence}`);
  }

  persistNativeCheckpoint(): void {
    if (!this.intact || !this.pending?.confirmed) throw new Error('model:unconfirmed_checkpoint');
    this.checkpoint = `model:checkpoint:${this.pending.commit.commitId}`;
    this.trace.push(`model:checkpoint:${this.pending.commit.commitSequence}`);
    this.pending = undefined;
  }

  append(commit: ProjectionSourceCommit): void {
    this.publish(commit);
    this.confirmIntendedQueue();
    this.persistNativeCheckpoint();
  }

  async openSession(start: LiveStartRecord, channel: Parameters<LiveFeedEvidencePort['openSession']>[1])
    : Promise<LiveEvidenceResult<LiveFeedSession>> {
    if (start.mode !== 'LIVE_FROM_BOUNDARY' || !this.intact || !this.checkpoint || this.pending || this.session || !isDeepStrictEqual(start, this.expected)
      || channel.queueName !== this.expected.queueName || channel.prefetch !== 1 || channel.exclusive !== true) {
      return { status: 'unproven', reason: 'model:continuity_unproven' };
    }
    const session = new ModelSession(start, channel.sessionRef, {
      issued: () => this.issued?.identity,
      first: (sourceId) => this.published.find((commit) => commit.streamId === sourceId),
      front: () => this.queue[0], settle: () => this.settle()
    });
    this.session = session;
    return { status: 'qualified', value: session };
  }

  issue(redelivered = false): LiveRabbitDelivery {
    const commit = this.queue[0];
    if (!commit || !this.session || this.issued || this.pending) throw new Error('model:delivery_refused');
    this.session.assertCurrent();
    const identity = { sessionRef: this.session.sessionRef, deliveryTag: ++this.tag, messageId: commit.commitId, redelivered };
    const raw: LiveRabbitDelivery = { fields: { deliveryTag: identity.deliveryTag, redelivered },
      properties: { messageId: commit.commitId, headers: { collection: modelScope.collection,
        partitionId: modelScope.partitionId, streamId: commit.streamId } },
      content: Buffer.from(JSON.stringify({ id: commit.commitId, streamId: commit.streamId,
        partitionId: modelScope.partitionId, commitSequence: commit.commitSequence,
        events: commit.events.map((event) => ({ id: event.eventId, version: event.streamVersion,
          aggregateType: event.aggregateType, aggregateId: event.aggregateId, type: event.type,
          payload: event.payload, timestamp: event.timestamp })) })) };
    this.issued = { identity, raw, acked: false };
    return raw;
  }

  acknowledge(raw: LiveRabbitDelivery): void {
    this.session?.assertCurrent();
    if (!this.issued || this.issued.raw !== raw || this.issued.acked) throw new Error('model:ack_refused');
    this.issued.acked = true;
    this.trace.push(`model:ack:${this.queue[0]?.commitSequence}`);
  }

  private settle(): void {
    if (!this.issued?.acked) throw new Error('model:settle_before_ack');
    this.queue.shift();
    this.issued = undefined;
  }

  loseContinuity(): void {
    this.intact = false;
    this.checkpoint = '';
    this.session?.invalidate();
  }
}
