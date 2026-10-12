import { randomUUID } from 'node:crypto';
import type {
  LiveCommitCoordinator, LiveConsumerSelection, LiveDeliveryIdentity, LiveFeedEvidencePort, LiveFeedSession, LiveSourceOrderPort, LiveStartRecord
} from '@redemeine/projection-runtime-core';
import { admitLiveDelivery } from './liveAdmissionEvidence';
import type { LiveDeliveryGate, LiveRabbitDelivery } from './liveDeliveryGate';
import { validateLiveStart } from './liveRegistration';

export interface LiveRabbitChannel {
  checkQueue(queue: string): Promise<unknown>;
  prefetch(count: number): Promise<unknown>;
  consume(queue: string, handler: (delivery: LiveRabbitDelivery | null) => void,
    options: { noAck: false; exclusive: boolean }): Promise<{ consumerTag: string }>;
  cancel(tag: string): Promise<unknown>;
  ack(delivery: LiveRabbitDelivery): void;
  close(): Promise<void>;
  on(event: 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'error', listener: () => void): unknown;
}

export interface LiveRabbitWorkerOptions {
  readonly start: LiveStartRecord;
  readonly evidence: LiveFeedEvidencePort;
  readonly sourceOrder: LiveSourceOrderPort;
  readonly gate: LiveDeliveryGate;
  readonly coordinator: LiveCommitCoordinator;
  readonly continuationDelayMs: number;
  readonly shutdownTimeoutMs: number;
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** No poller, retry republication, terminal NACK, or inactive-source cache in this path. */
export class LiveProjectionRabbitWorker {
  private channel: LiveRabbitChannel | undefined;
  private session: LiveFeedSession | undefined;
  private consumerTag: string | undefined;
  private work: Promise<void> | undefined;
  private reserved = false;
  private accepting = false;
  private starting = false;
  private epoch = 0;
  private reason: string | undefined;
  private disconnect: (() => void) | undefined;
  private closing: Promise<boolean> | undefined;
  private lastDeliveryTag = 0;
  private staged: LiveRabbitDelivery | undefined;
  private staging = false;
  private readonly options: LiveRabbitWorkerOptions;

  constructor(options: LiveRabbitWorkerOptions) {
    validateLiveStart(options.start);
    if (options.gate.sourceScopeDigest !== options.start.sourceScopeDigest) throw new Error('live_scope_mismatch');
    if (options.coordinator.epoch !== options.start.epoch || options.coordinator.registryDigest !== options.start.registryDigest
      || options.coordinator.generation !== options.start.generation) throw new Error('live_registry_mismatch');
    for (const value of [options.continuationDelayMs, options.shutdownTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new Error('invalid_live_worker_budget');
    }
    const start = options.start.mode === 'LIVE_FROM_QUEUE_BINDING'
      ? Object.freeze({ ...options.start, publisherContract: Object.freeze({ ...options.start.publisherContract }) })
      : Object.freeze({ ...options.start });
    this.options = { ...options, start };
  }

  getStatus(): { accepting: boolean; activeDeliveries: number; reason?: string } {
    return { accepting: this.accepting, activeDeliveries: this.reserved ? 1 : 0,
      ...(this.reason ? { reason: this.reason } : {}) };
  }

  async start(channel: LiveRabbitChannel): Promise<void> {
    if (this.channel || this.work || this.starting) throw new Error('live_worker_not_drained');
    this.starting = true;
    this.closing = undefined;
    this.lastDeliveryTag = 0;
    this.channel = channel;
    this.reason = undefined;
    const epoch = ++this.epoch;
    this.disconnect = () => this.pause('live_channel_lost');
    channel.on('close', this.disconnect);
    channel.on('error', this.disconnect);
    try {
      await this.begin(channel, epoch);
    } catch {
      this.pause('live_start_unproven');
      throw new Error('live_start_unproven');
    } finally { this.starting = false; }
  }

  private async begin(channel: LiveRabbitChannel, epoch: number): Promise<void> {
    await channel.checkQueue(this.options.start.queueName);
    await channel.prefetch(1);
    const sessionRef = randomUUID();
    const selection: LiveConsumerSelection = this.options.start.mode === 'LIVE_FROM_QUEUE_BINDING'
      ? { exclusive: false, consumerMode: 'single_active' } : { exclusive: true };
    const result = await this.options.evidence.openSession(this.options.start, { sessionRef,
      queueName: this.options.start.queueName, prefetch: 1, ...selection });
    if (result.status === 'unproven') throw new Error('live_start_unproven');
    if ((selection.exclusive && result.status !== 'qualified') || (!selection.exclusive && result.status !== 'staged')) {
      result.value.invalidate(); throw new Error('live_session_mode_mismatch');
    }
    if (epoch !== this.epoch || this.reason || result.value.start !== this.options.start || result.value.sessionRef !== sessionRef) {
      result.value.invalidate();
      throw new Error('live_session_mismatch');
    }
    this.session = result.value;
    if (!selection.exclusive) { await this.beginBroker(channel, epoch, result.value); return; }
    this.session.assertCurrent();
    this.accepting = true;
    const consumer = await channel.consume(this.options.start.queueName,
      (delivery) => this.receive(delivery, channel, epoch), { noAck: false, exclusive: true });
    this.consumerTag = consumer.consumerTag;
    if (!this.accepting || epoch !== this.epoch) await channel.cancel(consumer.consumerTag);
  }

  private async beginBroker(channel: LiveRabbitChannel, epoch: number, session: LiveFeedSession): Promise<void> {
    if (!session.activateConsumer) throw new Error('live_broker_activation_required');
    this.staging = true;
    const consumer = await channel.consume(this.options.start.queueName, (delivery) => {
      if (!this.staging) { this.receive(delivery, channel, epoch); return; }
      if (!delivery || this.staged || epoch !== this.epoch || this.reason) { this.pause('live_staged_delivery_refused'); return; }
      this.staged = delivery;
    }, { noAck: false, exclusive: false });
    this.consumerTag = consumer.consumerTag;
    if (epoch !== this.epoch || this.reason) { await channel.cancel(consumer.consumerTag); throw new Error('live_session_expired'); }
    await session.activateConsumer(consumer.consumerTag);
    if (epoch !== this.epoch || this.reason) throw new Error('live_session_expired');
    session.assertCurrent();
    this.accepting = true;
    this.staging = false;
    const delivery = this.staged;
    this.staged = undefined;
    if (delivery) this.receive(delivery, channel, epoch);
  }

  private receive(delivery: LiveRabbitDelivery | null, channel: LiveRabbitChannel, epoch: number): void {
    if (epoch !== this.epoch) return;
    if (!delivery) { this.pause('live_consumer_cancelled'); return; }
    if (!this.accepting || this.reserved) { this.pause('live_delivery_overlap'); return; }
    this.reserved = true;
    const session = this.session;
    try {
      if (!session || !delivery.properties.messageId || !Number.isSafeInteger(delivery.fields.deliveryTag)
        || delivery.fields.deliveryTag <= this.lastDeliveryTag) throw new Error('invalid_live_delivery');
      this.lastDeliveryTag = delivery.fields.deliveryTag;
      const identity = { sessionRef: session.sessionRef, deliveryTag: delivery.fields.deliveryTag,
        messageId: delivery.properties.messageId, redelivered: delivery.fields.redelivered };
      session.reserve(identity);
      this.work = Promise.resolve().then(() => this.handle(delivery, identity, session, channel, epoch))
        .catch(() => this.pause('live_delivery_refused')).finally(() => { this.work = undefined; this.reserved = false; });
    } catch {
      this.reserved = false;
      this.pause('live_delivery_unproven');
    }
  }

  private async handle(delivery: LiveRabbitDelivery, identity: LiveDeliveryIdentity, session: LiveFeedSession,
    channel: LiveRabbitChannel, epoch: number): Promise<void> {
    const assertCurrent = () => {
      session.assertCurrent();
      if (!this.accepting || epoch !== this.epoch || this.channel !== channel) throw new Error('live_session_expired');
    };
    assertCurrent();
    const commit = await this.options.gate.verify(delivery);
    assertCurrent();
    const position = await admitLiveDelivery(this.options.sourceOrder, session, commit, identity);
    while (true) {
      assertCurrent();
      const result = await this.options.coordinator.process(commit, position, assertCurrent);
      assertCurrent();
      if (result.status === 'paused') { this.pause('live_coordinator_paused'); return; }
      if (result.status === 'completed') {
        if (result.coveredThrough === null || result.coveredThrough < commit.commitSequence) throw new Error('live_coverage_incomplete');
        break;
      }
      if (result.processedCommits === 0) { this.pause('live_continuation_stalled'); return; }
      await boundedDelay(this.options.continuationDelayMs);
    }
    assertCurrent();
    channel.ack(delivery);
    session.settled(identity);
  }

  private pause(reason: string): void {
    this.accepting = false;
    this.staging = false;
    this.staged = undefined;
    this.reason ??= reason;
    this.session?.invalidate();
    if (this.channel && this.consumerTag) {
      const tag = this.consumerTag;
      this.consumerTag = undefined;
      void this.channel.cancel(tag).catch(() => { this.reason = 'live_cancel_uncertain'; });
    }
  }

  async stop(): Promise<{ drained: boolean }> {
    this.pause('live_stopped');
    ++this.epoch;
    this.closing ??= this.closeChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([Promise.all([this.work, this.closing]).then(([, closed]) => closed),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs); })]);
    if (timer) clearTimeout(timer);
    return { drained };
  }

  private async closeChannel(): Promise<boolean> {
    const channel = this.channel;
    if (!channel) return true;
    try {
      // Channel closure requeues unACKed obligations; it does not claim to cancel a database transaction.
      await channel.close();
      if (this.disconnect) {
        channel.removeListener('close', this.disconnect);
        channel.removeListener('error', this.disconnect);
      }
      this.channel = undefined;
      this.session = undefined;
      this.consumerTag = undefined;
      return true;
    } catch {
      this.reason = 'live_close_uncertain';
      return false;
    }
  }
}
