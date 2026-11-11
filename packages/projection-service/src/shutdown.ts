import { performance } from 'node:perf_hooks';

export class Shutdown {
  readonly controller = new AbortController();
  readonly done: Promise<number>;
  private resolve: (code: number) => void = () => {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private completed = false;
  deadline: number | undefined;
  expired = false;

  constructor(private readonly milliseconds: number, private readonly forceExit: (code: number) => void,
    private readonly onDeadline: () => void, private readonly now: () => number = () => performance.now()) {
    this.done = new Promise((resolve) => { this.resolve = resolve; });
  }

  begin(): boolean {
    if (this.deadline !== undefined) return false;
    this.deadline = this.now() + this.milliseconds;
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.deadline - this.now()));
    this.controller.abort();
    return true;
  }

  private expire(): void {
    if (this.expired || this.completed) return;
    this.expired = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.onDeadline(); }
    finally { this.resolve(124); this.forceExit(124); }
  }

  observeDeadline(): boolean {
    if (!this.completed && this.deadline !== undefined && this.now() >= this.deadline) this.expire();
    return this.expired;
  }

  finish(code: number): boolean {
    if (this.observeDeadline() || this.completed) return false;
    this.completed = true;
    if (this.timer) clearTimeout(this.timer);
    this.resolve(code);
    return true;
  }
}

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function attachSignals(source: SignalSource, stop: () => void): () => void {
  source.on('SIGINT', stop);
  source.on('SIGTERM', stop);
  return () => { source.removeListener('SIGINT', stop); source.removeListener('SIGTERM', stop); };
}
