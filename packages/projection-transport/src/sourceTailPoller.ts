import { isCanonicalProjectionUuid, validateCompleteCommitRange } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { MongoProjectionTransportStore } from './mongoTransportStore';
import type { TapewormMongoRangeReader } from './tapewormMongoRangeReader';

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
  private running = false;
  private healthy = false;

  constructor(private readonly options: SourceTailPollerOptions) {
    if (new Set(options.sourceIds).size !== options.sourceIds.length
      || options.sourceIds.some((id) => !isCanonicalProjectionUuid(id))
      || [options.maxCommits, options.maxBytes, options.maxPages, options.intervalMs, options.maxBootstrapPasses ?? 1]
        .some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Source tail polling requires finite explicit UUIDs and positive bounds.');
    }
  }

  isHealthy(): boolean { return this.healthy; }

  async bootstrap(): Promise<void> {
    await this.options.reader.initialize();
    await this.options.transport.initialize();
    try {
      let caughtUp = false;
      for (let attempt = 0; attempt < (this.options.maxBootstrapPasses ?? 1_000); attempt += 1) {
        caughtUp = await this.pollOnce();
        if (caughtUp) break;
        await new Promise((resolve) => setTimeout(resolve, this.options.intervalMs));
      }
      if (!caughtUp) throw new Error('Source tail bootstrap exceeded bounded page attempts.');
      this.healthy = true;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  start(): void {
    if (this.running || !this.healthy) throw new Error('Source tail must bootstrap before starting.');
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
    this.healthy = false;
  }

  async pollOnce(): Promise<boolean> {
    let caughtUp = true;
    for (const sourceId of this.options.sourceIds) {
      if (!await this.pollSource(sourceId)) caughtUp = false;
    }
    return caughtUp;
  }

  private async pollSource(sourceId: string): Promise<boolean> {
    const { record, highWatermark } = await this.options.transport.probeRegisteredSource(this.options.queueId, sourceId,
      'durable_queue_and_dlx_asserted');
    let after = await this.options.transport.loadCoveredThrough(this.options.queueId, sourceId);
    if (after === null) after = record.lastAcceptedSequence;
    if (after > highWatermark) throw new Error('Indexed source history precedes durable coverage.');
    for (let page = 0; after < highWatermark && page < this.options.maxPages; page += 1) {
      const request = { sourceId, afterSequence: after === -1 ? null : after, throughSequence: highWatermark,
        maxCommits: this.options.maxCommits, maxBytes: this.options.maxBytes };
      const result = await this.options.reader.readCompleteRange(request);
      if (result.status !== 'complete' || !validateCompleteCommitRange(request, result).valid) {
        throw new Error(`Complete indexed tail unavailable for ${sourceId} at ${after + 1}.`);
      }
      for (const entry of result.commits) {
        const outcome = await this.options.coordinator.processPolled(entry.commit);
        if (outcome.status !== 'completed') throw new Error(`Source tail dispatch failed: ${outcome.reason}`);
        after = entry.commit.commitSequence;
      }
    }
    return after === highWatermark;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.active = this.pollOnce().then((caughtUp) => { this.healthy = caughtUp; }).catch((error: unknown) => this.fail(error));
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
