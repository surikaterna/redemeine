import { SagaTurnError, SagaTurnPermanentError } from '@redemeine/saga-runtime';
import { createHash } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { SAGA_COMMIT_QUEUE, SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE } from './commitQueueTopology';
import type { SagaRabbitWorkerOptions } from './contracts';

const ATTEMPT = 'rdm-saga-retry-attempt';
const REASON = 'rdm-saga-failure-reason';
const MAX_ATTEMPTS = 100;

function poison(detail: string): SagaTurnPermanentError {
  return new SagaTurnPermanentError('invalid_retry_headers', detail);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertRetryConfiguration(retry: NonNullable<SagaRabbitWorkerOptions['retry']>): void {
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 0 || retry.maxAttempts > MAX_ATTEMPTS) {
    throw new TypeError('maxAttempts must be an explicit integer between 0 and 100');
  }
  if (retry.topology.queue !== SAGA_COMMIT_RETRY_QUEUE || retry.topology.exchange !== SAGA_COMMIT_RETRY_EXCHANGE ||
      typeof retry.topology.inspect !== 'function' || typeof retry.publisher?.retry !== 'function' ||
      typeof retry.publisher.deadLetter !== 'function' || typeof retry.consumerChannel?.close !== 'function') {
    throw new TypeError('retry requires the exact topology, dedicated confirmed publisher and consumer close');
  }
}

export function retryAttempt(message: ConsumeMessage, maxAttempts: number): number {
  const headers: unknown = message.properties.headers;
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(headers)); } catch { /* malformed headers are poison */ }
  if (!record(headers) || Object.keys(headers).length > 32 || bytes > 8192) {
    throw poison('retry headers exceed budget or are malformed');
  }
  const attempt = headers[ATTEMPT] === undefined ? 0 : headers[ATTEMPT];
  if (!Number.isSafeInteger(attempt) || typeof attempt !== 'number' || attempt < 0 || attempt > maxAttempts) {
    throw poison('retry attempt is invalid or exceeds maximum');
  }
  const deaths = headers['x-death'];
  if (deaths !== undefined) {
    if (!Array.isArray(deaths) || deaths.length !== 1 || !record(deaths[0]) ||
        deaths[0].queue !== SAGA_COMMIT_RETRY_QUEUE || deaths[0].reason !== 'expired' ||
        !Number.isSafeInteger(deaths[0].count) || typeof deaths[0].count !== 'number' ||
        deaths[0].count < 1 || deaths[0].count > maxAttempts ||
        deaths[0].count !== attempt) throw poison('retry TTL death evidence is contradictory');
  }
  if (attempt > 0 && deaths === undefined) {
    throw poison('retry attempt lacks broker TTL evidence');
  }
  return attempt;
}

function safeReason(error: unknown): string {
  // Never copy arbitrary exception messages or stacks into broker-visible headers.
  if (!(error instanceof SagaTurnError)) return 'processor_unknown';
  return /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'processor_failure';
}

export async function republishFailure(
  retry: NonNullable<SagaRabbitWorkerOptions['retry']>, message: ConsumeMessage, attempt: number, error: unknown
): Promise<void> {
  const reason = safeReason(error);
  if (!(error instanceof SagaTurnError) || error.retryable) {
    if (attempt >= retry.maxAttempts) {
      await deadLetterFailure(retry, message, attempt, reason);
      return;
    }
    await retry.publisher.retry(message, { [ATTEMPT]: attempt + 1, [REASON]: reason });
    return;
  }
  await deadLetterFailure(retry, message, attempt, reason);
}

async function deadLetterFailure(
  retry: NonNullable<SagaRabbitWorkerOptions['retry']>, message: ConsumeMessage, attempt: number, reason: string
): Promise<void> {
  // Invalid envelopes may not carry a messageId. Give the quarantined copy a stable
  // synthetic ID so mandatory returns can still be correlated on the confirm channel.
  const quarantined = message.properties.messageId ? message : {
    ...message, properties: { ...message.properties,
      messageId: `invalid-${createHash('sha256').update(message.content).digest('hex')}` }
  };
  await retry.publisher.deadLetter(quarantined, { [ATTEMPT]: attempt, [REASON]: reason });
}

export const RETRY_INPUT_QUEUE = SAGA_COMMIT_QUEUE;
