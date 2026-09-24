import { isDeepStrictEqual } from 'node:util';
import { isCanonicalProjectionUuid, validateCompleteCommitRange } from '@redemeine/projection-runtime-core';
import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { MongoProjectionTransportStore } from './mongoTransportStore';
import type { TapewormMongoRangeReader } from './tapewormMongoRangeReader';

export type SourceTailPass = 'caught_up' | 'continuation';

export class HistoricalNotificationRejectedError extends Error {
  constructor(readonly reason: 'historical_commit_unavailable' | 'historical_commit_mismatch') {
    super(reason);
  }
}

export interface SourceTailPollerOptions {
  readonly queueId: string;
  readonly sourceIds: readonly string[];
  readonly transport: MongoProjectionTransportStore;
  readonly reader: TapewormMongoRangeReader;
  readonly coordinator: ProjectionCommitCoordinator;
  readonly maxCommits: number;
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxBootstrapPasses?: number;
  readonly intervalMs: number;
  readonly onFailure: (error: Error) => void;
}

export class SourceTailPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private bootstrapping: Promise<void> | undefined;
  private wakeBootstrap: (() => void) | undefined;
  private running = false;
  private healthy = false;
  private stopping = false;

  constructor(private readonly options: SourceTailPollerOptions) {
    if (options.sourceIds.length === 0 || new Set(options.sourceIds).size !== options.sourceIds.length
      || options.sourceIds.some((id) => !isCanonicalProjectionUuid(id))
      || [options.maxCommits, options.maxBytes, options.maxPages, options.intervalMs, options.maxBootstrapPasses ?? 1]
        .some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Source tail polling requires finite explicit UUIDs and positive bounds.');
    }
  }

  isHealthy(): boolean { return this.healthy && !this.stopping; }

  async resolveNotification(notification: ProjectionSourceCommit): Promise<{
    status: 'authoritative' | 'accepted_baseline'; commit: ProjectionSourceCommit;
  }> {
    try {
      if (!this.options.sourceIds.includes(notification.streamId)) throw new Error('Unconfigured Rabbit source UUID.');
      const { record, highWatermark } = await this.options.transport.probeRegisteredSource(
        this.options.queueId, notification.streamId, 'durable_queue_and_dlx_asserted');
      if (record.queueBindingId !== this.options.queueId || record.sourceId !== notification.streamId) {
        throw new Error('Rabbit source does not match immutable queue binding.');
      }
      const preBaseline = notification.commitSequence <= record.lastAcceptedSequence;
      if (preBaseline && record.strategyScope.every(({ strategy }) => strategy !== 'none')) {
        return { status: 'accepted_baseline', commit: notification };
      }
      if (notification.commitSequence > highWatermark) {
        throw new Error('Rabbit source notification is beyond the indexed source tail.');
      }
      const sequence = notification.commitSequence;
      const request = { sourceId: notification.streamId, afterSequence: sequence === 0 ? null : sequence - 1,
        throughSequence: sequence, maxCommits: 1, maxBytes: this.options.maxBytes };
      const page = await this.options.reader.readCompleteRange(request);
      const authoritative = page.status === 'complete' ? page.commits[0]?.commit : undefined;
      if (preBaseline && page.status !== 'complete') {
        throw new HistoricalNotificationRejectedError('historical_commit_unavailable');
      }
      if (page.status !== 'complete' || !validateCompleteCommitRange(request, page).valid
        || page.commits.length !== 1 || !authoritative || !isDeepStrictEqual(authoritative, notification)) {
        if (preBaseline) throw new HistoricalNotificationRejectedError('historical_commit_mismatch');
        throw new Error('Rabbit notification does not match the complete indexed source commit.');
      }
      return { status: 'authoritative', commit: authoritative };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async bootstrap(): Promise<void> {
    if (this.running || this.bootstrapping) throw new Error('Source tail is already starting or running.');
    this.stopping = false;
    const work = this.runBootstrap();
    this.bootstrapping = work;
    try { await work; } finally { this.bootstrapping = undefined; }
  }

  private async runBootstrap(): Promise<void> {
    try {
      await this.options.reader.initialize();
      await this.options.transport.initialize();
      let result: SourceTailPass = 'continuation';
      for (let attempt = 0; attempt < (this.options.maxBootstrapPasses ?? 1_000); attempt += 1) {
        if (this.stopping) throw new Error('Source tail bootstrap stopped.');
        result = await this.pollOnce();
        if (this.stopping) throw new Error('Source tail bootstrap stopped.');
        if (result === 'caught_up') break;
        await this.pauseBootstrap();
      }
      if (result !== 'caught_up') throw new Error('Source tail bootstrap exceeded bounded page attempts.');
      if (this.stopping) throw new Error('Source tail bootstrap stopped.');
      this.healthy = true;
    } catch (error) {
      if (!this.stopping) this.fail(error);
      throw error;
    }
  }

  private pauseBootstrap(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeBootstrap = undefined; resolve(); }, this.options.intervalMs);
      this.wakeBootstrap = () => { clearTimeout(timer); this.wakeBootstrap = undefined; resolve(); };
    });
  }

  start(): void {
    if (this.running || !this.healthy) throw new Error('Source tail must bootstrap before starting.');
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeBootstrap?.();
    await Promise.allSettled([this.active, this.bootstrapping].filter((task): task is Promise<void> => !!task));
    this.healthy = false;
  }

  async pollOnce(): Promise<SourceTailPass> {
    if (this.stopping) return 'continuation';
    let result: SourceTailPass = 'caught_up';
    for (const sourceId of this.options.sourceIds) {
      if (await this.pollSource(sourceId) === 'continuation') result = 'continuation';
    }
    return result;
  }

  private async pollSource(sourceId: string): Promise<SourceTailPass> {
    const { record, highWatermark } = await this.options.transport.probeRegisteredSource(this.options.queueId, sourceId,
      'durable_queue_and_dlx_asserted');
    const binding = await this.options.transport.readQueueBinding(this.options.queueId);
    if (!binding || binding.queueId !== this.options.queueId || binding.manifestId !== record.manifestId
      || record.queueBindingId !== this.options.queueId || record.sourceId !== sourceId) {
      throw new Error('Configured source does not match immutable queue registry binding.');
    }
    let after = await this.options.transport.loadCoveredThrough(this.options.queueId, sourceId);
    if (after === null) after = record.lastAcceptedSequence;
    if (after > highWatermark) throw new Error('Indexed source history precedes durable coverage.');
    const initial = after;
    for (let page = 0; !this.stopping && after < highWatermark && page < this.options.maxPages; page += 1) {
      const request = { sourceId, afterSequence: after === -1 ? null : after, throughSequence: highWatermark,
        maxCommits: this.options.maxCommits, maxBytes: this.options.maxBytes };
      const result = await this.options.reader.readCompleteRange(request);
      if (result.status !== 'complete' || !validateCompleteCommitRange(request, result).valid) {
        throw new Error(`Complete indexed tail unavailable for ${sourceId} at ${after + 1}.`);
      }
      for (const entry of result.commits) {
        if (this.stopping) break;
        const outcome = await this.options.coordinator.processPolled(entry.commit);
        if (outcome.status !== 'completed') throw new Error(`Source tail dispatch failed: ${outcome.reason}`);
        after = entry.commit.commitSequence;
      }
    }
    if (after < highWatermark && after === initial && !this.stopping) {
      throw new Error(`Indexed source tail stalled without progress for ${sourceId}.`);
    }
    return !this.stopping && after === highWatermark ? 'caught_up' : 'continuation';
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.active = this.pollOnce().then(() => {
        this.healthy = !this.stopping;
      }).catch((error: unknown) => { if (!this.stopping) this.fail(error); });
      void this.active.finally(() => { this.active = undefined; this.schedule(); });
    }, this.options.intervalMs);
  }

  private fail(error: unknown): void {
    this.healthy = false;
    try {
      this.options.onFailure(error instanceof Error ? error : new Error('Source tail polling failed.'));
    } catch {
      // Reporting failure cannot restart admission or hide the unhealthy state.
    }
  }
}
