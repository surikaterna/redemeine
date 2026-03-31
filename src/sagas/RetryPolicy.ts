export interface SagaRetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffCoefficient: number;
  maxBackoffMs?: number;
  jitterCoefficient?: number;
}

export type RetryableErrorClassification = 'retryable' | 'non-retryable';

export type RetryableErrorPredicate = (error: unknown) => boolean | undefined;

export interface RetryableErrorClassificationOptions {
  predicate?: RetryableErrorPredicate;
  useDefaults?: boolean;
}

const DEFAULT_RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT'
]);

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 409, 410, 422]);
const DEFAULT_NON_RETRYABLE_ERROR_NAMES = new Set(['ValidationError', 'NonRetryableError']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readObjectProperty(target: unknown, key: string): unknown {
  if (!target || typeof target !== 'object') {
    return undefined;
  }

  return (target as Record<string, unknown>)[key];
}

function normalizeErrorCode(error: unknown): string | undefined {
  const code = readObjectProperty(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function normalizeErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }

  const name = readObjectProperty(error, 'name');
  return typeof name === 'string' ? name : undefined;
}

function normalizeErrorStatus(error: unknown): number | undefined {
  const status = readObjectProperty(error, 'status') ?? readObjectProperty(error, 'statusCode');
  return typeof status === 'number' ? status : undefined;
}

/**
 * Validates a retry policy shape and constraints.
 *
 * Throws when policy values are invalid and returns the same object when valid.
 */
export function validateRetryPolicy(policy: SagaRetryPolicy): SagaRetryPolicy {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('Retry policy maxAttempts must be an integer greater than or equal to 1.');
  }

  if (!isFiniteNumber(policy.initialBackoffMs) || policy.initialBackoffMs < 0) {
    throw new RangeError('Retry policy initialBackoffMs must be a finite number greater than or equal to 0.');
  }

  if (!isFiniteNumber(policy.backoffCoefficient) || policy.backoffCoefficient < 1) {
    throw new RangeError('Retry policy backoffCoefficient must be a finite number greater than or equal to 1.');
  }

  if (policy.maxBackoffMs !== undefined) {
    if (!isFiniteNumber(policy.maxBackoffMs) || policy.maxBackoffMs < 0) {
      throw new RangeError('Retry policy maxBackoffMs must be a finite number greater than or equal to 0.');
    }

    if (policy.maxBackoffMs < policy.initialBackoffMs) {
      throw new RangeError('Retry policy maxBackoffMs must be greater than or equal to initialBackoffMs.');
    }
  }

  if (policy.jitterCoefficient !== undefined) {
    if (!isFiniteNumber(policy.jitterCoefficient) || policy.jitterCoefficient < 0 || policy.jitterCoefficient > 1) {
      throw new RangeError('Retry policy jitterCoefficient must be between 0 and 1 inclusive.');
    }
  }

  return policy;
}

/**
 * Determines whether an error should be retried.
 *
 * Predicate can return true/false to force classification, or undefined to
 * defer to the default classification heuristics.
 */
export function isRetryableError(
  error: unknown,
  options: RetryableErrorClassificationOptions = {}
): boolean {
  const { predicate, useDefaults = true } = options;

  if (predicate) {
    const result = predicate(error);
    if (typeof result === 'boolean') {
      return result;
    }
  }

  if (!useDefaults) {
    return false;
  }

  const explicitRetryable = readObjectProperty(error, 'retryable');
  if (explicitRetryable === true) {
    return true;
  }

  if (explicitRetryable === false) {
    return false;
  }

  const name = normalizeErrorName(error);
  if (name && DEFAULT_NON_RETRYABLE_ERROR_NAMES.has(name)) {
    return false;
  }

  const code = normalizeErrorCode(error);
  if (code && DEFAULT_RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const statusCode = normalizeErrorStatus(error);
  if (statusCode !== undefined) {
    if (DEFAULT_NON_RETRYABLE_STATUS_CODES.has(statusCode)) {
      return false;
    }

    if (DEFAULT_RETRYABLE_STATUS_CODES.has(statusCode)) {
      return true;
    }
  }

  return false;
}

export function classifyRetryableError(
  error: unknown,
  options?: RetryableErrorClassificationOptions
): RetryableErrorClassification {
  return isRetryableError(error, options) ? 'retryable' : 'non-retryable';
}
