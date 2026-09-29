import type { SagaTopologyChannel } from './topology';

export interface RetryBrokerState {
  readonly queue: unknown;
  readonly exchange: unknown;
  readonly bindings: unknown;
  readonly streamQueueEnabled: boolean;
}

export interface SagaRetryTopology {
  readonly queue: string;
  readonly exchange: string;
  readonly delayMs: number;
  /** Must query broker management in the same vhost, not echo requested declarations. */
  readonly inspect: () => Promise<RetryBrokerState>;
}

const retryArguments = (delayMs: number) => ({
  'x-queue-type': 'quorum',
  'x-message-ttl': delayMs,
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': 'rdm.saga.commits',
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish'
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertFields(value: unknown, fields: Record<string, unknown>, label: string): void {
  const actual = record(value);
  if (!actual || Object.entries(fields).some(([key, expected]) => actual[key] !== expected)) {
    throw new Error(`retry broker ${label} does not match required configuration`);
  }
}

/** Reject dynamic policies that could override queue arguments or silently disable safe dead lettering. */
export function verifyRetryBroker(state: RetryBrokerState, retry: SagaRetryTopology): void {
  if (state.streamQueueEnabled !== true) throw new Error('retry broker stream_queue feature flag is not enabled');
  const queue = record(state.queue);
  if (!queue) throw new Error('retry broker queue inspection unavailable');
  assertFields(queue, { name: retry.queue, type: 'quorum', durable: true, auto_delete: false, exclusive: false }, 'queue');
  const required = retryArguments(retry.delayMs);
  assertFields(queue.arguments, required, 'queue arguments');
  if (Object.keys(record(queue.arguments) ?? {}).length !== Object.keys(required).length) {
    throw new Error('retry broker unexpected queue arguments');
  }
  const policyKeys: Record<string, string> = {
    'message-ttl': 'x-message-ttl', 'dead-letter-exchange': 'x-dead-letter-exchange',
    'dead-letter-routing-key': 'x-dead-letter-routing-key', 'dead-letter-strategy': 'x-dead-letter-strategy',
    overflow: 'x-overflow'
  };
  for (const key of ['effective_policy_definition', 'operator_policy_definition']) {
    const policy = record(queue[key]);
    if (queue[key] != null && !policy) throw new Error('retry broker policy inspection unavailable');
    if (policy && Object.keys(policy).some((name) => !(name in policyKeys))) {
      throw new Error(`retry broker ${key} has unsupported settings`);
    }
    for (const [policyKey, argumentKey] of Object.entries(policyKeys)) {
      if (policy && policyKey in policy && policy[policyKey] !== required[argumentKey as keyof typeof required]) {
        throw new Error(`retry broker ${key} conflicts with required configuration`);
      }
    }
  }
  assertFields(state.exchange, { name: retry.exchange, type: 'direct', durable: true, auto_delete: false }, 'exchange');
  const exchange = record(state.exchange);
  if (!exchange || !record(exchange.arguments) || Object.keys(record(exchange.arguments) ?? {}).length !== 0) {
    throw new Error('retry broker exchange arguments mismatch');
  }
  if (!Array.isArray(state.bindings) || state.bindings.length !== 1) throw new Error('retry broker exact binding missing');
  assertFields(state.bindings[0], {
    source: retry.exchange, destination: retry.queue, destination_type: 'queue', routing_key: retry.queue
  }, 'binding');
  const binding = record(state.bindings[0]);
  if (!binding || !record(binding.arguments) || Object.keys(record(binding.arguments) ?? {}).length !== 0) {
    throw new Error('retry broker binding arguments mismatch');
  }
}

export async function provisionRetryTopology(channel: SagaTopologyChannel, retry: SagaRetryTopology): Promise<void> {
  if (!Number.isSafeInteger(retry.delayMs) || retry.delayMs <= 0 || retry.delayMs > 2_147_483_647 ||
      typeof retry.inspect !== 'function') throw new TypeError('retry topology requires a positive delay and broker inspection');
  const exchange = await channel.assertExchange(retry.exchange, 'direct', { durable: true, autoDelete: false });
  if (exchange.exchange !== retry.exchange) throw new Error('retry exchange name mismatch');
  const queue = await channel.assertQueue(retry.queue, {
    durable: true, autoDelete: false, exclusive: false, arguments: retryArguments(retry.delayMs)
  });
  if (queue.queue !== retry.queue) throw new Error('retry queue name mismatch');
  await channel.bindQueue(retry.queue, retry.exchange, retry.queue);
  verifyRetryBroker(await retry.inspect(), retry);
}
