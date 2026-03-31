/** Health event emitted when the daemon starts polling. */
export interface SagaRouterDaemonStartedHealthEvent {
  readonly type: 'started';
  readonly pollIntervalMs: number;
  readonly startedAt: string;
}

/** Health event emitted after each poll tick is processed. */
export interface SagaRouterDaemonTickHealthEvent {
  readonly type: 'tick';
  readonly tickCount: number;
  readonly processedCount: number;
  readonly processedAt: string;
}

/** Health event emitted when the daemon loop exits. */
export interface SagaRouterDaemonStoppedHealthEvent {
  readonly type: 'stopped';
  readonly tickCount: number;
  readonly stoppedAt: string;
}

/** Union of observable daemon health events. */
export type SagaRouterDaemonHealthEvent =
  | SagaRouterDaemonStartedHealthEvent
  | SagaRouterDaemonTickHealthEvent
  | SagaRouterDaemonStoppedHealthEvent;

/** Optional structured logger hooks for daemon health event fan-out. */
export interface SagaRouterDaemonLoggerHooks {
  readonly started?: (event: SagaRouterDaemonStartedHealthEvent) => void;
  readonly tick?: (event: SagaRouterDaemonTickHealthEvent) => void;
  readonly stopped?: (event: SagaRouterDaemonStoppedHealthEvent) => void;
}

export interface SagaRouterDaemonOptions {
  /** Polling interval between ticks in milliseconds (default: 1000) */
  readonly pollIntervalMs?: number;
  /** Optional structured logger hooks for health events */
  readonly logger?: SagaRouterDaemonLoggerHooks;
  /** Optional observer for all daemon health events */
  readonly onHealthEvent?: (event: SagaRouterDaemonHealthEvent) => void;
  /**
   * Tick seam for future routing implementation.
   * Returns the number of records processed by the tick.
   */
  readonly processTick?: () => number | Promise<number>;
  /** Optional startup scan for recovering pending intents before polling loop */
  readonly startupScan?: () => number | Promise<number>;
  /** Optional timeout scanner hook that emits due wake-up intents */
  readonly timeoutScan?: () => number | Promise<number>;
  /** Internal seam for testability */
  readonly createTimestamp?: () => string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Polling daemon seam for routing pending saga intents to worker handlers.
 *
 * Current implementation focuses on lifecycle orchestration and observability.
 */
export class SagaRouterDaemon {
  private readonly pollIntervalMs: number;
  private readonly logger?: SagaRouterDaemonLoggerHooks;
  private readonly onHealthEvent?: (event: SagaRouterDaemonHealthEvent) => void;
  private readonly processTickFn: () => number | Promise<number>;
  private readonly startupScanFn?: () => number | Promise<number>;
  private readonly timeoutScanFn?: () => number | Promise<number>;
  private readonly createTimestamp: () => string;

  private running = false;
  private shouldStop = false;
  private tickCount = 0;

  constructor(options: SagaRouterDaemonOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger;
    this.onHealthEvent = options.onHealthEvent;
    this.processTickFn = options.processTick ?? (() => 0);
    this.startupScanFn = options.startupScan;
    this.timeoutScanFn = options.timeoutScan;
    this.createTimestamp = options.createTimestamp ?? (() => new Date().toISOString());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get ticksProcessed(): number {
    return this.tickCount;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.shouldStop = false;

    const startedEvent: SagaRouterDaemonStartedHealthEvent = {
      type: 'started',
      pollIntervalMs: this.pollIntervalMs,
      startedAt: this.createTimestamp()
    };
    this.emitHealthEvent(startedEvent);

    if (this.startupScanFn) {
      await this.startupScanFn();
    }

    try {
      while (!this.shouldStop) {
        await this.tick();

        if (!this.shouldStop) {
          await this.delay(this.pollIntervalMs);
        }
      }
    } finally {
      this.running = false;

      const stoppedEvent: SagaRouterDaemonStoppedHealthEvent = {
        type: 'stopped',
        tickCount: this.tickCount,
        stoppedAt: this.createTimestamp()
      };
      this.emitHealthEvent(stoppedEvent);
    }
  }

  stop(): void {
    this.shouldStop = true;
  }

  async tick(): Promise<number> {
    const timeoutScannedCount = this.timeoutScanFn ? await this.timeoutScanFn() : 0;
    const processedCount = await this.processTickFn();
    const totalProcessedCount = timeoutScannedCount + processedCount;
    this.tickCount += 1;

    const tickEvent: SagaRouterDaemonTickHealthEvent = {
      type: 'tick',
      tickCount: this.tickCount,
      processedCount: totalProcessedCount,
      processedAt: this.createTimestamp()
    };
    this.emitHealthEvent(tickEvent);

    return totalProcessedCount;
  }

  private emitHealthEvent(event: SagaRouterDaemonHealthEvent): void {
    this.onHealthEvent?.(event);

    if (event.type === 'started') {
      this.logger?.started?.(event);
      return;
    }

    if (event.type === 'tick') {
      this.logger?.tick?.(event);
      return;
    }

    this.logger?.stopped?.(event);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
