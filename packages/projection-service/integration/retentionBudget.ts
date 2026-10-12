import { setTimeout as delay } from 'node:timers/promises';
import { budgets, QualificationError } from './plan';
import type { Unjoined } from './cancellation';
import type { MalformedPort } from './malformedRetention';

export interface RetentionBudgetOptions { now?: () => number; unjoined?: Unjoined }

export class RetentionBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly pending = new Map<Promise<unknown>, string>();
  private readonly interrupted: Promise<never>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.expire('qualification_stopping');

  constructor(private readonly parent: AbortSignal, private readonly options: RetentionBudgetOptions = {}) {
    this.signal = this.controller.signal; this.now = options.now ?? (() => performance.now());
    this.deadline = this.now() + budgets.scenarioMs;
    this.interrupted = new Promise((_resolve, reject) => this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true }));
    void this.interrupted.catch(() => {});
    this.timer = setTimeout(() => this.expire('qualification_condition_deadline'), budgets.scenarioMs);
    parent.addEventListener('abort', this.abort, { once: true }); if (parent.aborted) this.abort();
  }

  private expire(reason: string): void {
    if (this.signal.aborted) return;
    for (const label of this.pending.values()) {
      try { this.options.unjoined?.(`malformed_${label}`); } catch { /* Reporting cannot replace deadline or cleanup authority. */ }
    }
    this.controller.abort(new QualificationError(reason));
  }

  check(): void {
    if (!this.signal.aborted && this.now() >= this.deadline) this.expire('qualification_condition_deadline');
    if (this.signal.aborted) throw this.signal.reason;
  }

  async step<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check();
    const task = Promise.resolve().then(() => { this.check(); return operation(this.signal); });
    this.pending.set(task, label);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    try { const value = await Promise.race([task, this.interrupted]); this.check(); return value; }
    catch (error) { this.check(); throw error; }
  }

  async poll(check: () => Promise<boolean>): Promise<void> {
    for (;;) {
      const matched = await this.step('predicate', () => check()); this.check();
      if (matched) return;
      await this.step('poll_delay', (signal) => delay(Math.min(100, this.deadline - this.now()), undefined, { signal }));
      this.check();
    }
  }

  wrap(port: MalformedPort): MalformedPort {
    return { queue: () => this.step('queue', (signal) => port.queue(signal)),
      health: (path) => this.step(path === '/live' ? 'live_health' : 'ready_health', (signal) => port.health(path, signal)),
      control: () => this.step('control', (signal) => port.control(signal)), publish: () => this.step('publish', (signal) => port.publish(signal)),
      stop: () => this.step('stop', (signal) => port.stop(signal)), observe: (facts) => this.step('observe', (signal) => port.observe(facts, signal)) };
  }

  close(): void {
    clearTimeout(this.timer); this.parent.removeEventListener('abort', this.abort);
    this.expire('qualification_stopping');
  }
}
