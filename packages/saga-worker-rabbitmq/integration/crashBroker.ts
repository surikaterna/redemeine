import type { Channel } from 'amqplib';
import { createSagaCommitQueueTopology, provisionSagaTopology } from '../src/index';
import { inspectRetryBroker } from './retryBrokerAudit';

export const input = 'rdm.saga.commits';
export const retryQueue = 'rdm.saga.commits.retry';
export const deadQueue = 'rdm.saga.commits.dlq';
export const delayMs = 12_000;

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function management(path: string, method = 'GET', body?: object): Promise<unknown> {
  const url = new URL(path.replaceAll('/%2F/', `/${encodeURIComponent(required('REDEMEINE_CRASH_VHOST'))}/`),
    required('REDEMEINE_RABBIT_MANAGEMENT_URL'));
  const auth = Buffer.from(`${required('REDEMEINE_RABBIT_USER')}:${required('REDEMEINE_RABBIT_PASSWORD')}`).toString('base64');
  const response = await fetch(url, { method, signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Rabbit management HTTP ${response.status}`);
  return response.status === 204 || response.status === 201 && method !== 'GET' ? null : response.json();
}

export function topology(channel: Channel) {
  return createSagaCommitQueueTopology({ channel, sourceExchange: required('REDEMEINE_CRASH_EXCHANGE'),
    collection: required('REDEMEINE_CRASH_COLLECTION'), partitions: [required('REDEMEINE_CRASH_PARTITION')],
    retryDelayMs: delayMs, inspectRetry: () => inspectRetryBroker((path) => management(path)) });
}

export async function provision(channel: Channel): Promise<ReturnType<typeof topology>> {
  const scope = topology(channel);
  await provisionSagaTopology(scope);
  return scope;
}

export async function counts(queue: string): Promise<{ ready: number; unacked: number; ack: number }> {
  return parseQueueCounts(await management(`/api/queues/%2F/${encodeURIComponent(queue)}`));
}

export type QueueCounts = { ready: number; unacked: number; ack: number };

export class QueueMetricsError extends Error {}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseQueueCounts(value: unknown): QueueCounts {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('messages_ready' in value) || !('messages_unacknowledged' in value)) throw new QueueMetricsError('queue metrics missing');
  const ready = value.messages_ready;
  const unacked = value.messages_unacknowledged;
  let ack: unknown = 0;
  if ('message_stats' in value) {
    const stats = value.message_stats;
    if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) throw new QueueMetricsError('invalid queue metrics');
    ack = 'ack' in stats ? stats.ack : 0;
  }
  if (!validCount(ready) || !validCount(unacked) || !validCount(ack)) throw new QueueMetricsError('invalid queue metrics');
  return { ready, unacked, ack };
}
