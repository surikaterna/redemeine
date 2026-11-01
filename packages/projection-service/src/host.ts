import { performance } from 'node:perf_hooks';
import type { HostOptions } from './config';
import { HealthServer } from './health';
import { HostAttempt, type AttemptResult, type ConnectResource } from './hostAttempt';
import { Observations } from './observability';
import { OwnershipError, type Ownership } from './ownership';
import { abortableDelay, RetryBudget } from './reconnect';
import { attachSignals, Shutdown, type SignalSource } from './shutdown';

export interface HostDependencies {
  acquire(signal: AbortSignal): Promise<Ownership>;
  connect: ConnectResource;
  readonly signals: SignalSource;
  forceExit(code: number): void;
  readonly observations?: Observations;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class ProjectionHost {
  readonly observations: Observations;
  private readonly shutdown: Shutdown;
  private readonly retries: RetryBudget;
  private readonly now: () => number;
  private owner: Ownership | undefined;
  private health: HealthServer | undefined;
  private healthClosing: Promise<void> | undefined;
  private attempt: HostAttempt | undefined;
  private running: Promise<void> = Promise.resolve();
  private cleanup: Promise<void> | undefined;
  private detach: () => void = () => {};
  private monitor: ReturnType<typeof setInterval> | undefined;
  private wake: ((result: AttemptResult) => void) | undefined;
  private started = false;

  constructor(private readonly options: HostOptions, private readonly dependencies: HostDependencies) {
    this.observations = dependencies.observations ?? new Observations(undefined, options.mode);
    this.now = dependencies.now ?? (() => performance.now());
    this.retries = new RetryBudget(options.reconnectAttempts, dependencies.random);
    this.shutdown = new Shutdown(options.shutdownTimeoutMs, dependencies.forceExit, () => {
      this.observations.transition('stopping', 'shutdown_deadline'); this.detach();
    }, this.now);
  }

  start(): Promise<number> {
    if (this.started) throw new Error('host_already_started');
    this.started = true;
    this.detach = attachSignals(this.dependencies.signals, () => this.stop());
    this.running = this.run().catch((error: unknown) => this.stop(error instanceof OwnershipError ? error.exitCode : 1));
    return this.shutdown.done;
  }

  get healthPort(): number | undefined { return this.health?.port; }

  snapshot() {
    let ready = false;
    try { ready = this.checkCurrent(); }
    catch { this.fail({ reason: 'worker_paused', retry: false }); }
    return this.observations.snapshot(this.options.mode === 'reference' && ready, this.options.mode === 'external' && ready);
  }

  private checkCurrent(): boolean {
    if (!['reference_active', 'external_active'].includes(this.observations.phase) || this.shutdown.controller.signal.aborted) return false;
    const status = this.attempt?.resource?.worker.getStatus();
    if (!status?.accepting) {
      this.fail({ reason: status?.reason === 'live_channel_lost' ? 'channel_lost' : 'worker_paused',
        retry: status?.reason === 'live_channel_lost' });
      return false;
    }
    if (!this.attempt?.fence.current()) { this.fail({ reason: 'session_invalid', retry: false }); return false; }
    this.retries.observeStable(this.now(), true);
    return this.observations.owned;
  }

  private fail(result: AttemptResult): void {
    this.observations.transition(result.retry ? 'backoff' : 'paused', result.reason);
    this.attempt?.invalidate();
    this.wake?.(result);
  }

  private async run(): Promise<void> {
    const signal = this.shutdown.controller.signal;
    this.owner = await this.dependencies.acquire(signal);
    this.observations.owned = true;
    if (signal.aborted) return;
    this.observations.transition('locked');
    try {
      this.health = new HealthServer(() => this.snapshot(), () => this.stop(1));
      await this.health.start(this.options.healthPort);
      if (!signal.aborted) await this.supervise();
    } finally {
      await this.attempt?.cleanup(() => this.cleanupFailed());
    }
  }

  private async supervise(): Promise<void> {
    const signal = this.shutdown.controller.signal;
    while (!signal.aborted && this.retries.begin()) {
      this.attempt = new HostAttempt();
      this.observations.transition('connecting');
      let result = await this.attempt.begin(this.dependencies.connect, signal, this.options.connectTimeoutMs);
      if (result.reason === 'none' && !signal.aborted) result = await this.watch();
      if (!signal.aborted) this.fail(result);
      await this.attempt.cleanup(() => this.cleanupFailed());
      if (signal.aborted) return;
      if (!result.retry) { await this.waitForStop(); return; }
      this.observations.retries += 1;
      await abortableDelay(this.retries.delay(), signal);
    }
    if (!signal.aborted) { this.observations.transition('paused', 'retry_exhausted'); await this.waitForStop(); }
  }

  private watch(): Promise<AttemptResult> {
    return new Promise((resolve) => {
      this.wake = (result) => {
        if (this.monitor) clearInterval(this.monitor);
        this.monitor = undefined;
        this.wake = undefined;
        resolve(result);
      };
      this.observations.transition(this.options.mode === 'reference' ? 'reference_active' : 'external_active');
      this.monitor = setInterval(() => { this.snapshot(); }, 50);
      this.snapshot();
    });
  }

  private cleanupFailed(): void {
    this.observations.transition(this.shutdown.controller.signal.aborted ? 'stopping' : 'paused', 'cleanup_failed');
  }

  private waitForStop(): Promise<void> {
    const signal = this.shutdown.controller.signal;
    return new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  stop(code = 0): void {
    if (!this.shutdown.begin()) return;
    this.observations.transition('stopping', code === 73 ? 'ownership_contended' : code ? 'host_failed' : 'shutdown');
    this.attempt?.invalidate();
    this.wake?.({ reason: 'shutdown', retry: false });
    if (this.monitor) clearInterval(this.monitor);
    this.healthClosing = this.health?.close();
    void this.healthClosing?.catch(() => undefined);
    this.cleanup = this.finish(code);
    void this.cleanup.catch(() => { this.observations.transition('stopping', 'cleanup_failed'); });
  }

  private async finish(code: number): Promise<void> {
    await this.running;
    await this.healthClosing;
    if (this.shutdown.observeDeadline()) return;
    await this.owner?.close();
    if (!this.shutdown.finish(code)) return;
    this.observations.owned = false;
    this.observations.transition('stopped');
    this.detach();
  }
}
