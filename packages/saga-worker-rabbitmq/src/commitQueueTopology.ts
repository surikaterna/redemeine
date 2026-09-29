import type { SagaRabbitWorkerOptions } from './contracts';
import type { SagaTopologyOptions } from './topology';

export const SAGA_COMMIT_QUEUE = 'rdm.saga.commits';
export const SAGA_COMMIT_DEAD_QUEUE = 'rdm.saga.commits.dlq';
export const SAGA_COMMIT_DEAD_EXCHANGE = 'rdm.saga.commits.dlx';
export const SAGA_COMMIT_RETRY_QUEUE = 'rdm.saga.commits.retry';
export const SAGA_COMMIT_RETRY_EXCHANGE = 'rdm.saga.commits.retry.exchange';

export interface SagaCommitQueueTopologyConfig {
  readonly channel: SagaTopologyOptions['channel'] & SagaRabbitWorkerOptions['channel'];
  readonly sourceExchange: string;
  readonly collection: string;
  readonly partitions: readonly string[];
  readonly tenant?: string;
  readonly publisherTenant?: string;
  /** Fixed queue TTL in milliseconds; no implicit retry delay. */
  readonly retryDelayMs: number;
  /** Independently inspect the effective broker state, including policies and bindings. */
  readonly inspectRetry: NonNullable<SagaTopologyOptions['retry']>['inspect'];
}

/** Assemble one shared commit intake per vhost; provision before starting any worker. */
export function createSagaCommitQueueTopology(config: SagaCommitQueueTopologyConfig): SagaTopologyOptions {
  const { channel, sourceExchange, collection, partitions, tenant, publisherTenant, retryDelayMs, inspectRetry } = config;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0 || retryDelayMs > 2_147_483_647) {
    throw new TypeError('retryDelayMs must be a positive signed 32-bit integer');
  }
  if (typeof inspectRetry !== 'function') throw new TypeError('retry broker inspection is required');
  const worker: SagaTopologyOptions['worker'] = {
    channel,
    source: { collection, partitions },
    queue: {
      queue: SAGA_COMMIT_QUEUE,
      options: {
        durable: true, autoDelete: false, exclusive: false,
        deadLetterExchange: SAGA_COMMIT_DEAD_EXCHANGE, deadLetterRoutingKey: SAGA_COMMIT_DEAD_QUEUE
      },
      deadLetterExchange: {
        name: SAGA_COMMIT_DEAD_EXCHANGE, type: 'direct', options: { durable: true, autoDelete: false }
      }
    }
  };
  return {
    channel, worker, sourceExchange, deadQueue: SAGA_COMMIT_DEAD_QUEUE,
    deadRoutingKey: SAGA_COMMIT_DEAD_QUEUE,
    retry: { queue: SAGA_COMMIT_RETRY_QUEUE, exchange: SAGA_COMMIT_RETRY_EXCHANGE, delayMs: retryDelayMs, inspect: inspectRetry },
    ...(tenant === undefined ? {} : { tenant }),
    ...(publisherTenant === undefined ? {} : { publisherTenant })
  };
}
