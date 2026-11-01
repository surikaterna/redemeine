export class TransientConnectionError extends Error {
  constructor() { super('connection_transient'); }
}

export class RetryBudget {
  private attempts = 0;
  private stableSince: number | undefined;
  constructor(private readonly limit: number, private readonly random: () => number = Math.random) {}

  begin(): boolean {
    if (this.attempts >= this.limit) return false;
    this.attempts += 1;
    this.stableSince = undefined;
    return true;
  }

  observeStable(now: number, qualified: boolean): void {
    if (!qualified) { this.stableSince = undefined; return; }
    this.stableSince ??= now;
    if (now - this.stableSince >= 30000) this.attempts = 0;
  }

  delay(): number {
    const random = this.random();
    const fraction = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 1;
    return Math.floor(fraction * Math.min(5000, 250 * 2 ** Math.max(0, this.attempts - 1)));
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
