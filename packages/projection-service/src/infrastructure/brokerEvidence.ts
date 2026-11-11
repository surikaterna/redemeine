import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { FirstLiveEvidence, LiveBrokerStartRecord, LiveDeliveryIdentity, LiveEvidenceResult,
  LiveFeedEvidencePort, LiveFeedOpenResult, LiveStartRecord, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { BrokerTopology } from './brokerTopology';
import type { OwnedBrokerChannel } from './brokerIdentity';
import { BrokerRefusal } from './brokerSchema';
import { waitForConsumerActivation } from './consumerActivation';
import { observeStartup, type StartupObserver } from '../startupDiagnostics';

export class BrokerEvidence implements LiveFeedEvidencePort {
  private opened = false;
  private stopped = false;
  private active = false;
  private faulted = false;
  private checkedAt = -Infinity;
  private tag: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private reservation: LiveDeliveryIdentity | undefined;
  private readonly activationAbort = new AbortController();
  private activationFailure: unknown;
  private activating: Promise<void> | undefined;

  constructor(private readonly expected: LiveBrokerStartRecord, private readonly channel: OwnedBrokerChannel,
    private readonly topology: BrokerTopology, private readonly now: () => number = () => performance.now(),
    private readonly observe?: StartupObserver) {}

  async openSession(start: LiveStartRecord, selection: Parameters<LiveFeedEvidencePort['openSession']>[1])
    : Promise<LiveFeedOpenResult> {
    if (this.opened || this.stopped || start.mode !== 'LIVE_FROM_QUEUE_BINDING' || !isDeepStrictEqual(start, this.expected)
      || selection.queueName !== start.queueName || selection.prefetch !== 1 || selection.exclusive !== false
      || selection.consumerMode !== 'single_active' || !selection.sessionRef) {
      this.activationFailure = new BrokerRefusal('broker_session_mismatch');
      observeStartup(this.observe, 'consumer_start', this.activationFailure);
      return { status: 'unproven', reason: 'broker_session_mismatch' };
    }
    this.opened = true;
    const sessionRef = selection.sessionRef;
    return { status: 'staged', value: {
      start, sessionRef, assertCurrent: () => this.assertCurrent(), invalidate: () => this.invalidate(),
      activateConsumer: (tag) => {
        if (this.activating) throw new BrokerRefusal('broker_session_expired');
        this.activating = this.activate(tag);
        return this.activating;
      },
      reserve: (delivery) => {
        this.assertCurrent();
        if (delivery.sessionRef !== sessionRef || this.reservation || !this.channel.owns(delivery)) {
          throw new BrokerRefusal('broker_reservation_mismatch');
        }
        this.reservation = delivery;
      },
      certifyFirst: (commit, delivery) => this.first(start, commit, delivery),
      settled: (delivery) => {
        this.assertCurrent();
        if (this.reservation !== delivery) throw new BrokerRefusal('broker_reservation_mismatch');
        this.reservation = undefined;
      }
    } };
  }

  private async activate(tag: string): Promise<void> {
    try {
      if (this.stopped || this.tag || this.channel.consumerTag() !== tag) throw new BrokerRefusal('broker_session_expired');
      this.tag = tag;
      await waitForConsumerActivation(() => this.initialInspection(), () => this.channel.assertCurrent(), this.activationAbort.signal, this.now);
      if (this.stopped) throw new BrokerRefusal('broker_session_expired');
      this.active = true;
      this.assertCurrent();
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 5000);
    } catch (error) {
      this.activationFailure = error;
      observeStartup(this.observe, 'consumer_start', error);
      if (!this.stopped) this.faulted = true;
      this.invalidate();
      throw error;
    }
  }

  private initialInspection(): Promise<void> {
    this.refreshing = this.inspect(true).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.inspect().catch((error: unknown) => {
      if (!this.stopped) this.faulted = true;
      this.invalidate();
      throw error;
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async inspect(initial = false): Promise<void> {
    const started = this.now();
    if (this.stopped || !this.tag) throw new BrokerRefusal('broker_session_expired');
    this.channel.assertCurrent();
    await this.topology.inspect(this.expected.queueNonce, { tag: this.tag, identity: this.channel.identity() }, initial);
    if (this.stopped || this.now() - started >= 10000) throw new BrokerRefusal('broker_topology_stale');
    this.channel.assertCurrent();
    this.checkedAt = started;
  }

  assertCurrent(): void {
    if (this.stopped || !this.active) throw new BrokerRefusal('broker_session_expired');
    if (this.now() - this.checkedAt >= 10000) {
      this.faulted = true;
      this.invalidate();
      throw new BrokerRefusal('broker_session_expired');
    }
    try { this.channel.assertCurrent(); }
    catch { this.invalidate(); throw new BrokerRefusal('broker_session_expired'); }
  }

  hasObservedFault(): boolean { return this.faulted; }
  startupFailure(): unknown { return this.activationFailure; }
  permitsCleanRestart(): boolean { return !this.faulted && this.refreshing === undefined; }

  private async first(start: LiveBrokerStartRecord, commit: ProjectionSourceCommit, delivery: LiveDeliveryIdentity)
    : Promise<LiveEvidenceResult<FirstLiveEvidence>> {
    this.assertCurrent();
    if (this.reservation !== delivery || delivery.redelivered || !this.channel.owns(delivery) || commit.commitId !== delivery.messageId) {
      return { status: 'unproven', reason: 'broker_first_not_preserved' };
    }
    return { status: 'qualified', value: {
      kind: 'broker_first_retained_delivery', start, delivery,
      position: Object.freeze({ epoch: start.epoch, registryDigest: start.registryDigest, sourceId: commit.streamId,
        firstSequence: commit.commitSequence, firstCommitId: commit.commitId, coveredThrough: null }),
      assertCurrent: () => {
        this.assertCurrent();
        if (this.reservation !== delivery || !this.channel.owns(delivery)) throw new BrokerRefusal('broker_reservation_expired');
      }
    } };
  }

  invalidate(): void {
    this.stopped = true;
    this.activationAbort.abort();
    this.active = false;
    this.reservation = undefined;
    if (this.timer) clearInterval(this.timer);
  }

  async close(): Promise<void> {
    this.invalidate();
    await this.activating?.catch(() => undefined);
    await this.refreshing?.catch(() => undefined);
  }
}
