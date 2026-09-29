import { DeadlineExceededError, deadline } from './crashOwnership';
import { ChildStartupFailure, type ChildError } from './crashChildStages';

export const phases = ['mongo-connect', 'resource-preflight', 'resource-setup', 'mongo-owner-create',
  'amqp-open', 'consumer-channel', 'confirm-channel', 'topology-provision', 'topology-inspected',
  'stack-construction', 'child-fork', 'source-append', 'child-ready', 'source-publish',
  'initial-delivery', 'retry-confirm', 'broker-observation', 'physical-commit-read',
  'crash-assertions', 'kill-eligibility', 'recovery', 'cleanup', 'receipt'] as const;
export type CrashPhase = typeof phases[number];

export interface FailureEvidence {
  readonly phase: CrashPhase;
  readonly errorClass: 'timeout' | 'child_exit' | 'assertion' | 'network' | 'operation';
  readonly code: number | 'ECONNREFUSED' | 'ETIMEDOUT' | 'ECONNRESET' | null;
  readonly source: 'crash-parent';
  readonly childPhase?: ChildError['phase'];
  readonly childClass?: ChildError['errorClass'];
}

function safeCode(error: unknown): FailureEvidence['code'] {
  if (typeof error !== 'object' || error === null) return null;
  const value = 'replyCode' in error ? error.replyCode : 'code' in error ? error.code : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999) return value;
  return value === 'ECONNREFUSED' || value === 'ETIMEDOUT' || value === 'ECONNRESET' ? value : null;
}

export function safeFailure(phase: CrashPhase, error: unknown, exitCode?: number | null): FailureEvidence {
  const child = error instanceof ChildStartupFailure ? error.evidence : null;
  const code = child ? child.code : exitCode !== null && exitCode !== undefined ? exitCode : safeCode(error);
  const name = error instanceof Error ? error.name : '';
  const errorClass = child ? child.errorClass === 'timeout' ? 'timeout' : child.errorClass === 'network' ? 'network' :
    child.errorClass === 'exit' ? 'child_exit' : 'operation' :
    error instanceof DeadlineExceededError || name === 'TimeoutError' || name === 'AbortError' ? 'timeout' :
    exitCode !== null && exitCode !== undefined ? 'child_exit' :
    name === 'AssertionError' ? 'assertion' :
    typeof code === 'string' ? 'network' : 'operation';
  return { phase, source: 'crash-parent', errorClass,
    ...(child ? { childPhase: child.phase, childClass: child.errorClass } : {}), code: typeof code === 'number' &&
    (!Number.isSafeInteger(code) || code < 0 || code > 999) ? null : code };
}

export class PhaseEvidence {
  private phase: CrashPhase = 'mongo-connect';
  readonly steps: Array<{ phase: CrashPhase; status: 'started' | 'completed' }> = [];
  firstFailure: FailureEvidence | null = null;

  async run<T>(phase: CrashPhase, operation: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
    this.phase = phase;
    this.steps.push({ phase, status: 'started' });
    try {
      const result = await deadline(phase, () => Promise.resolve().then(operation), timeoutMs);
      this.steps.push({ phase, status: 'completed' });
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  fail(error: unknown, exitCode?: number | null): void {
    if (!this.firstFailure) this.firstFailure = safeFailure(this.phase, error, exitCode);
  }
}
