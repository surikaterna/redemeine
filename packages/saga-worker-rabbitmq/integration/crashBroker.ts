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
  const response = await fetch(url, { method, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
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
  const value = await management(`/api/queues/%2F/${encodeURIComponent(queue)}`);
  if (typeof value !== 'object' || value === null || !('messages_ready' in value) ||
      !('messages_unacknowledged' in value) || !('message_stats' in value)) throw new Error('queue metrics missing');
  const stats = value.message_stats;
  const ack = typeof stats === 'object' && stats !== null && 'ack' in stats ? stats.ack : 0;
  if (typeof value.messages_ready !== 'number' || typeof value.messages_unacknowledged !== 'number' ||
      typeof ack !== 'number') throw new Error('invalid queue metrics');
  return { ready: value.messages_ready, unacked: value.messages_unacknowledged, ack };
}
