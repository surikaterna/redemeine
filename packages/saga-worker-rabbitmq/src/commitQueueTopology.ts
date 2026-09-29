import type { SagaRabbitWorkerOptions } from './contracts';
import type { SagaTopologyOptions } from './topology';

export const SAGA_COMMIT_QUEUE = 'rdm.saga.commits';
export const SAGA_COMMIT_DEAD_QUEUE = 'rdm.saga.commits.dlq';
export const SAGA_COMMIT_DEAD_EXCHANGE = 'rdm.saga.commits.dlx';

export interface SagaCommitQueueTopologyConfig {
  readonly channel: SagaTopologyOptions['channel'] & SagaRabbitWorkerOptions['channel'];
  readonly sourceExchange: string;
  readonly collection: string;
  readonly partitions: readonly string[];
  readonly tenant?: string;
  readonly publisherTenant?: string;
}

/** Assemble one shared commit intake per vhost; provision before starting any worker. */
export function createSagaCommitQueueTopology(config: SagaCommitQueueTopologyConfig): SagaTopologyOptions {
  const { channel, sourceExchange, collection, partitions, tenant, publisherTenant } = config;
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
    ...(tenant === undefined ? {} : { tenant }),
    ...(publisherTenant === undefined ? {} : { publisherTenant })
  };
}
