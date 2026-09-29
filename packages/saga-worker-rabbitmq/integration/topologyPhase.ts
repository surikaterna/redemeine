export const PHASES = [
  'setup-topology', 'inspect-topology', 'publish-routed', 'publish-wrong-partition', 'publish-wrong-tenant',
  'publish-wrong-collection', 'broker-restart', 'restore-topology', 'held-unack', 'ack-settlement',
  'dead-letter', 'mismatch-setup', 'mismatch-reply-406', 'restricted-user-setup', 'restricted-reply-403'
] as const;
export type Phase = (typeof PHASES)[number];

export const INVARIANTS = [
  'declared-and-bound', 'broker-inspected', 'routed-confirmed', 'mandatory-return', 'queue-ready-one',
  'same-volume-restarted', 'queue-retained-one', 'held-unack-one', 'queue-acked-zero', 'single-ack',
  'dead-letter-visible', 'declaration-conflict', 'reply-code-406', 'restricted-channel', 'reply-code-403', 'broker-available'
] as const;
export type Invariant = (typeof INVARIANTS)[number];

export const PHASE_MARKER = 'REDEMEINE_TOPOLOGY_PHASE:';
const SOURCE = 'integration/topology-real.integration.test.ts';

export class SafePhaseError extends Error {
  constructor(details: Record<string, string | number | null>) {
    super(`${PHASE_MARKER}${Buffer.from(JSON.stringify(details)).toString('base64url')}`);
    this.name = 'SafePhaseError';
  }
}

export class BrokerUnavailableError extends Error {
  constructor() {
    super('broker unavailable for isolated negative case');
    this.name = 'BrokerUnavailableError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function replyCode(error: unknown, depth = 0): number | null {
  const value = record(error);
  if (!value || depth > 3) return null;
  return numeric(value.code) ?? numeric(value.replyCode) ?? replyCode(value.cause, depth + 1);
}

function errorClass(error: unknown): string {
  const value = record(error);
  if (value?.name === 'BrokerUnavailableError') return 'blocked_on_broker_unavailable';
  const message = value?.message;
  if (typeof message === 'string' && /timed out|timeout/i.test(message)) return 'timeout';
  if (replyCode(error) !== null) return 'broker-reply';
  if (value?.name === 'AssertionError' || value?.matcherResult) return 'assertion';
  return 'operation';
}

function sourceLine(error: unknown): number {
  const trace = new Error().stack ?? record(error)?.stack;
  const match = typeof trace === 'string' ? trace.match(/topology-real\.integration\.test\.ts:(\d+)/) : null;
  return match?.[1] ? Number(match[1]) : 1;
}

export function safePhaseFailure(phase: Phase, invariant: Invariant, error: unknown): SafePhaseError {
  const value = record(error);
  const matcher = record(value?.matcherResult);
  return new SafePhaseError({ phase, invariant, errorClass: errorClass(error), code: replyCode(error),
    replyCode: numeric(value?.replyCode), expected: numeric(value?.expectedCode) ?? numeric(matcher?.expected),
    actual: numeric(value?.actualCode) ?? numeric(matcher?.actual), source: SOURCE, line: sourceLine(error) });
}

export async function phaseStep<T>(phase: Phase, invariant: Invariant, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw error instanceof SafePhaseError ? error : safePhaseFailure(phase, invariant, error); }
}
