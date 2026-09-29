import type { Channel } from 'amqplib';
import type { SagaRabbitWorkerOptions } from './contracts';
import { provisionRetryTopology, type SagaRetryTopology } from './retryTopology';

export type SagaTopologyChannel = Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue' | 'checkQueue'>;

export interface SagaTopologyOptions {
  readonly channel: SagaTopologyChannel;
  readonly worker: Pick<SagaRabbitWorkerOptions, 'channel' | 'queue' | 'source'>;
  readonly sourceExchange: string;
  readonly deadQueue: string;
  readonly deadRoutingKey: string;
  /** Must be the actual tenant supplied to the deployed Tapeworm Dispatcher. */
  readonly publisherTenant?: string;
  readonly tenant?: string;
  readonly retry?: SagaRetryTopology;
}

export class SagaTopologyError extends Error {
  constructor(step: string, cause: unknown) {
    super(`Saga Rabbit topology ${step} failed; consumer must not start; inspect broker declarations/permissions and reconnect on a new channel`, { cause });
    this.name = 'SagaTopologyError';
  }
}

function named(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || Buffer.byteLength(value) > 255) {
    throw new TypeError(`${label} must be a nonempty, trimmed name of at most 255 bytes`);
  }
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new TypeError(`${label} has unsupported keys: ${extra.join(', ')}`);
}

function validate(options: SagaTopologyOptions): void {
  const { worker, sourceExchange, deadQueue, deadRoutingKey, tenant, publisherTenant } = options;
  exactKeys(options, ['channel', 'worker', 'sourceExchange', 'deadQueue', 'deadRoutingKey', 'tenant', 'publisherTenant', 'retry'], 'topology');
  if (options.retry) {
    exactKeys(options.retry, ['queue', 'exchange', 'delayMs', 'inspect'], 'retry topology');
    if (options.retry.queue !== 'rdm.saga.commits.retry' || options.retry.exchange !== 'rdm.saga.commits.retry.exchange' ||
        worker.queue.queue !== 'rdm.saga.commits' || deadQueue !== 'rdm.saga.commits.dlq') {
      throw new TypeError('retry topology must use the production commit queue family');
    }
  }
  exactKeys(worker.source, ['collection', 'partitions'], 'source scope');
  named(sourceExchange, 'sourceExchange');
  named(deadQueue, 'deadQueue');
  named(deadRoutingKey, 'deadRoutingKey');
  named(worker.queue.queue, 'input queue');
  named(worker.queue.deadLetterExchange.name, 'dead-letter exchange');
  named(worker.source.collection, 'collection');
  if (!Array.isArray(worker.source.partitions) || worker.source.partitions.length === 0) {
    throw new TypeError('at least one partitionId is required');
  }
  worker.source.partitions.forEach((partition) => named(partition, 'partitionId'));
  if (new Set(worker.source.partitions).size !== worker.source.partitions.length) {
    throw new TypeError('duplicate partitionId');
  }
  if (tenant !== undefined) named(tenant, 'tenant');
  if (publisherTenant !== undefined) named(publisherTenant, 'publisherTenant');
  if (tenant !== publisherTenant) throw new TypeError('tenant must match the configured upstream publisherTenant');
  if (new Set([sourceExchange, deadQueue, worker.queue.queue, worker.queue.deadLetterExchange.name]).size !== 4) {
    throw new TypeError('exchange and queue names must be distinct');
  }
  const { deadLetterExchange } = worker.queue;
  const input = worker.queue;
  exactKeys(worker.queue, ['queue', 'options', 'deadLetterExchange'], 'worker queue');
  exactKeys(deadLetterExchange, ['name', 'type', 'options'], 'dead-letter exchange');
  exactKeys(deadLetterExchange.options, ['durable', 'autoDelete'], 'dead-letter exchange options');
  exactKeys(input.options, ['durable', 'autoDelete', 'exclusive', 'deadLetterExchange', 'deadLetterRoutingKey'], 'input queue options');
  if (deadLetterExchange.type !== 'direct' || deadLetterExchange.options.durable !== true || deadLetterExchange.options.autoDelete !== false ||
      input.options.durable !== true || input.options.autoDelete !== false || input.options.exclusive !== false ||
      input.options.deadLetterExchange !== deadLetterExchange.name || input.options.deadLetterRoutingKey !== deadRoutingKey) {
    throw new TypeError('worker queue/DLX declarations must match durable topology');
  }
  if (!Object.is(options.channel, worker.channel)) throw new TypeError('topology and worker must use the same channel');
}

async function step<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new SagaTopologyError(label, cause);
  }
}

/** Provision on every new connection before calling worker.start(); never reuse readiness across channels. */
export async function provisionSagaTopology(options: SagaTopologyOptions): Promise<void> {
  validate(options);
  const { channel, worker, sourceExchange, deadQueue, deadRoutingKey, tenant } = options;
  const { deadLetterExchange } = worker.queue;
  const inputQueue = worker.queue;
  const source = await step('assert source headers exchange', () => channel.assertExchange(sourceExchange, 'headers', { durable: true, autoDelete: false }));
  if (source.exchange !== sourceExchange) throw new SagaTopologyError('source exchange name mismatch', source);
  const dlx = await step('assert direct dead-letter exchange', () => channel.assertExchange(deadLetterExchange.name, 'direct', { durable: true, autoDelete: false }));
  if (dlx.exchange !== deadLetterExchange.name) throw new SagaTopologyError('dead-letter exchange name mismatch', dlx);
  const dead = await step('assert dead queue', () => channel.assertQueue(deadQueue, { durable: true, autoDelete: false, exclusive: false }));
  if (dead.queue !== deadQueue) throw new SagaTopologyError('dead queue name mismatch', dead);
  await step('bind dead queue', () => channel.bindQueue(deadQueue, dlx.exchange, deadRoutingKey));
  const input = await step('assert input queue', () => channel.assertQueue(inputQueue.queue, inputQueue.options));
  if (input.queue !== inputQueue.queue) throw new SagaTopologyError('input queue name mismatch', input);
  const checked = await step('check input queue', () => channel.checkQueue(inputQueue.queue));
  if (checked.queue !== inputQueue.queue) throw new SagaTopologyError('checked queue name mismatch', checked);
  for (const partitionId of worker.source.partitions) {
    const headers = { 'x-match': 'all', collection: worker.source.collection, partitionId, ...(tenant === undefined ? {} : { tenant }) };
    await step(`bind input queue partition ${partitionId}`, () => channel.bindQueue(inputQueue.queue, sourceExchange, '', headers));
  }
  if (options.retry) {
    await step('declare and inspect quorum retry topology', () => provisionRetryTopology(channel, options.retry!));
  }
}
