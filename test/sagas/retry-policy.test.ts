import { describe, expect, it } from '@jest/globals';
import {
  classifyRetryableError,
  isRetryableError,
  validateRetryPolicy,
  type SagaRetryPolicy
} from '../../src/sagas';

describe('saga retry policy helpers', () => {
  const validPolicy: SagaRetryPolicy = {
    maxAttempts: 3,
    initialBackoffMs: 250,
    backoffCoefficient: 2,
    maxBackoffMs: 5_000,
    jitterCoefficient: 0.25
  };

  it('accepts a valid retry policy', () => {
    expect(validateRetryPolicy(validPolicy)).toBe(validPolicy);
  });

  it('rejects invalid retry policy values', () => {
    expect(() => validateRetryPolicy({ ...validPolicy, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...validPolicy, initialBackoffMs: -1 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...validPolicy, backoffCoefficient: 0.5 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...validPolicy, maxBackoffMs: 100 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...validPolicy, jitterCoefficient: 1.5 })).toThrow(RangeError);
  });

  it('classifies default retryable and non-retryable errors', () => {
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ statusCode: 422 })).toBe(false);
    expect(classifyRetryableError(new Error('boom'))).toBe('non-retryable');
  });

  it('honors explicit retryable flag on error object', () => {
    expect(isRetryableError({ retryable: true, status: 400 })).toBe(true);
    expect(isRetryableError({ retryable: false, code: 'ETIMEDOUT' })).toBe(false);
  });

  it('supports custom predicate override and fallback', () => {
    expect(
      isRetryableError({ code: 'EWHATEVER' }, {
        predicate: () => true
      })
    ).toBe(true);

    expect(
      classifyRetryableError(
        { status: 503 },
        {
          predicate: () => undefined
        }
      )
    ).toBe('retryable');

    expect(
      isRetryableError(
        { code: 'ETIMEDOUT' },
        {
          useDefaults: false,
          predicate: () => undefined
        }
      )
    ).toBe(false);
  });
});
