export const PHASES = [
  'setup-topology', 'inspect-topology', 'publish-routed', 'publish-wrong-partition', 'publish-wrong-tenant',
  'publish-wrong-collection', 'broker-restart', 'restore-topology', 'held-unack', 'ack-settlement',
  'dead-letter', 'mismatch-setup', 'mismatch-reply-406', 'restricted-user-setup', 'restricted-reply-403',
  'production-health', 'production-open', 'production-provision', 'production-inspect',
  'production-publisher-connect', 'production-publisher-publish', 'production-publisher-close',
  'production-delivery', 'production-wrong-partition', 'production-wrong-collection', 'production-wrong-tenant',
  'production-ready', 'production-reopen', 'production-retained-topology', 'production-retained-message',
  'production-reprovision', 'production-held-ack', 'production-dlq', 'production-close',
  'restricted-health', 'restricted-connect', 'restricted-channel', 'restricted-close'
] as const;
export type Phase = (typeof PHASES)[number];

export const INVARIANTS = [
  'declared-and-bound', 'broker-inspected', 'routed-confirmed', 'mandatory-return', 'queue-ready-one',
  'same-volume-restarted', 'queue-retained-one', 'held-unack-one', 'queue-acked-zero', 'single-ack',
  'dead-letter-visible', 'declaration-conflict', 'reply-code-406', 'restricted-channel', 'reply-code-403', 'broker-available',
  'owner-channel-open', 'publisher-connected', 'publisher-confirmed', 'publisher-closed', 'publisher-observed',
  'retained-before-provision', 'channel-closed'
] as const;
export type Invariant = (typeof INVARIANTS)[number];

export const PHASE_MARKER = 'REDEMEINE_TOPOLOGY_PHASE:';
const SOURCE = 'integration/topology-real.integration.test.ts';

export interface RestartEvidence {
  readonly restartSubphase: 'docker-restart' | 'app-ready' | 'amqp-connect';
  readonly restartDocker: boolean;
  readonly restartApp: boolean;
  readonly restartAmqp: boolean;
  readonly amqpErrorClass: 'none' | 'ECONNREFUSED' | 'ETIMEDOUT' | 'ACCESS_REFUSED' | 'auth-failure' | 'channel-close' | 'unknown';
  readonly amqpCode: number | null;
}

export class SafePhaseError extends Error {
  constructor(details: Record<string, string | number | boolean | null>) {
    super(`${PHASE_MARKER}${Buffer.from(JSON.stringify(details)).toString('base64url')}`);
    this.name = 'SafePhaseError';
  }
}

export class BrokerUnavailableError extends Error {
  constructor(readonly restartEvidence?: RestartEvidence) {
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

function amqpCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 ? value : null;
}

function replyCode(error: unknown, depth = 0): number | null {
  const value = record(error);
  if (!value || depth > 3) return null;
  return numeric(value.code) ?? numeric(value.replyCode) ?? replyCode(value.cause, depth + 1);
}

function errorClass(error: unknown): string {
  const value = record(error);
  if (value?.name === 'BrokerUnavailableError') return 'blocked_on_broker_unavailable';
  if (value?.name === 'BrokerRestartTimeoutError') return 'timeout';
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
  const restart = record(value?.restartEvidence);
  const restartFields = restart && ['docker-restart', 'app-ready', 'amqp-connect'].includes(String(restart.restartSubphase)) ? {
    restartSubphase: String(restart.restartSubphase), restartDocker: Boolean(restart.restartDocker),
    restartApp: Boolean(restart.restartApp), restartAmqp: Boolean(restart.restartAmqp),
    amqpErrorClass: ['none', 'ECONNREFUSED', 'ETIMEDOUT', 'ACCESS_REFUSED', 'auth-failure', 'channel-close', 'unknown']
      .includes(String(restart.amqpErrorClass)) ? String(restart.amqpErrorClass) : 'unknown',
    amqpCode: amqpCode(restart.amqpCode)
  } : {};
  return new SafePhaseError({ phase, invariant, errorClass: errorClass(error), code: replyCode(error),
    replyCode: numeric(value?.replyCode), expected: numeric(value?.expectedCode) ?? numeric(matcher?.expected),
    actual: numeric(value?.actualCode) ?? numeric(matcher?.actual), source: SOURCE, line: sourceLine(error), ...restartFields });
}

export async function phaseStep<T>(phase: Phase, invariant: Invariant, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw error instanceof SafePhaseError ? error : safePhaseFailure(phase, invariant, error); }
}

/** Cleanup remains mandatory, but never replaces the first operational failure. */
export async function withSafeClose<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try { result = { ok: true, value: await work() }; }
  catch (error) { result = { ok: false, error }; }
  try { await close(); }
  catch (error) { if (result.ok) result = { ok: false, error }; }
  if (!result.ok) throw result.error;
  return result.value;
}
