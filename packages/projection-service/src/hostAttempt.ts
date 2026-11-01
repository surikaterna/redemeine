import type { HostReason } from './observability';
import { TransientConnectionError } from './reconnect';
import { SessionFence } from './sessionFence';
import { BrokerRefusal } from './infrastructure/brokerSchema';

export interface HostWorker {
  getStatus(): { accepting: boolean; activeDeliveries: number; reason?: string };
  stop(): Promise<{ drained: boolean }>;
}
export interface HostResource {
  readonly worker: HostWorker;
  start(): Promise<void>;
  close(): Promise<void>;
}
export type ConnectResource = (signal: AbortSignal, fence: SessionFence) => Promise<HostResource>;
export interface AttemptResult { reason: HostReason; retry: boolean }

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return operation(); } catch (error) { return Promise.reject(error); }
}

function startupReason(error: unknown): HostReason {
  if (error instanceof TransientConnectionError) return 'connection_transient';
  if (error instanceof BrokerRefusal && error.reason === 'restart_reconciliation_required') return 'restart_reconciliation_required';
  return 'startup_refused';
}

function waitForStartup(task: Promise<void>, signal: AbortSignal, milliseconds: number): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const finish = (result: AttemptResult) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => finish({ reason: 'shutdown', retry: false });
    const timer = setTimeout(() => finish({ reason: 'startup_timeout', retry: false }), milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    void task.then(() => finish({ reason: 'none', retry: false }), (error: unknown) => finish({
      reason: startupReason(error),
      retry: error instanceof TransientConnectionError }));
    if (signal.aborted) abort();
  });
}

export class HostAttempt {
  readonly fence = new SessionFence();
  resource: HostResource | undefined;
  private task: Promise<void> = Promise.resolve();
  private stopping: Promise<{ drained: boolean }> | undefined;
  private closing: Promise<void> | undefined;

  async begin(connect: ConnectResource, signal: AbortSignal, milliseconds: number): Promise<AttemptResult> {
    this.task = invoke(() => connect(signal, this.fence)).then(async (resource) => {
      this.resource = resource;
      if (signal.aborted || this.fence.halted) { this.invalidate(); return; }
      await resource.start();
    });
    return waitForStartup(this.task, signal, milliseconds);
  }

  invalidate(): void {
    this.fence.stop();
    if (!this.resource || this.stopping) return;
    this.stopping = invoke(() => this.resource ? this.resource.worker.stop() : Promise.resolve({ drained: true }));
    void this.stopping.catch(() => undefined);
  }

  cleanup(onFailure: () => void): Promise<void> {
    this.invalidate();
    this.closing ??= this.join(onFailure);
    return this.closing;
  }

  private async join(onFailure: () => void): Promise<void> {
    await this.task.catch(() => undefined);
    this.invalidate();
    try {
      const result = await this.stopping;
      await this.resource?.close();
      if (result && !result.drained) { onFailure(); await new Promise<void>(() => {}); }
    } catch {
      onFailure();
      await new Promise<void>(() => {});
    }
  }
}
