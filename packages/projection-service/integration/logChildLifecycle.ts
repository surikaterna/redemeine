import { QualificationError } from './plan';
import type { Unjoined } from './cancellation';

export type LogRefusal = 'qualification_stopping' | 'qualification_spawn_failed' | 'qualification_log_deadline'
  | 'qualification_log_stream_failed' | 'qualification_log_input_capacity' | 'qualification_log_signal_failed' | 'qualification_log_process_error';
export interface LogChildHandle {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'error' | 'spawn', listener: (error?: unknown) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

export class LogChildUnjoined extends QualificationError {
  readonly unjoined = true;
  constructor(readonly firstCause: LogRefusal) { super('qualification_log_child_unjoined'); }
}

function errorCode(error: unknown): unknown {
  try { return error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined; }
  catch { return undefined; }
}

export class LogChildLifecycle {
  readonly result: Promise<{ code: number | null; signal: string | null }>;
  private resolve: (value: { code: number | null; signal: string | null }) => void = () => {};
  private reject: (error: unknown) => void = () => {};
  private closed = false;
  private settled = false;
  private spawned = false;
  private terminating = false;
  private cause: LogRefusal | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private grace: ReturnType<typeof setTimeout> | undefined;
  private readonly deadline: number;
  private readonly abort = () => this.stop('qualification_stopping');

  constructor(private readonly child: LogChildHandle, milliseconds: number, private readonly signal: AbortSignal,
    private readonly unjoined: Unjoined = () => {}, private readonly now: () => number = () => performance.now()) {
    this.deadline = now() + milliseconds;
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    child.on('spawn', () => { this.spawned = true; });
    child.on('error', (error) => this.error(error));
    child.once('close', (code, termination) => this.close(code, termination));
    this.timer = setTimeout(() => this.stop('qualification_log_deadline'), milliseconds);
    signal.addEventListener('abort', this.abort, { once: true }); if (signal.aborted) this.abort();
  }

  get refused(): boolean { return this.cause !== undefined || this.settled; }

  private error(error: unknown): void {
    if (this.closed || this.settled) return;
    const code = errorCode(error);
    const noChild = this.noChild();
    const spawnFailure = noChild && ['ENOENT', 'EACCES', 'EAGAIN', 'ENOMEM'].some((known) => known === code);
    const reason: LogRefusal = spawnFailure ? 'qualification_spawn_failed'
      : code === 'EPERM' || code === 'EACCES' ? 'qualification_log_signal_failed' : 'qualification_log_process_error';
    this.cause ??= reason;
    // Even a no-child error keeps close observation; error alone never joins a live child.
    if (!spawnFailure) this.stop(reason);
  }

  private noChild(): boolean {
    try { return !this.spawned && this.child.pid === undefined; } catch { return false; }
  }

  stop(reason: LogRefusal): void {
    if (this.closed || this.settled) return;
    this.cause ??= reason;
    if (this.terminating) return;
    this.terminating = true;
    this.grace = setTimeout(() => {
      this.kill('SIGKILL');
      if (!this.closed) this.failUnjoined();
    }, 2000);
    this.kill('SIGTERM');
  }

  private kill(signal: NodeJS.Signals): void {
    try { this.child.kill(signal); } catch (error) { this.error(error); }
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer); if (this.grace) clearTimeout(this.grace);
    this.signal.removeEventListener('abort', this.abort);
  }

  private failUnjoined(): void {
    if (this.settled) return;
    this.settled = true; this.clear();
    try { this.unjoined('log_child_close'); } catch { /* An error marker also carries unjoined status if reporting fails. */ }
    this.reject(new LogChildUnjoined(this.cause ?? 'qualification_log_process_error'));
  }

  private close(code: number | null, termination: string | null): void {
    this.closed = true; this.clear();
    if (this.settled) return;
    if (this.now() >= this.deadline) this.cause ??= 'qualification_log_deadline';
    this.settled = true;
    if (this.cause) this.reject(new QualificationError(this.cause));
    else this.resolve({ code, signal: termination });
  }
}
