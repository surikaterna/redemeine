import type { RetryBrokerState } from '../src/index';

type Inspect = (path: string) => Promise<unknown>;

export async function inspectRetryBroker(inspect: Inspect): Promise<RetryBrokerState> {
  const queue = await inspect('/api/queues/%2F/rdm.saga.commits.retry');
  const exchange = await inspect('/api/exchanges/%2F/rdm.saga.commits.retry.exchange');
  const bindings = await inspect('/api/bindings/%2F/e/rdm.saga.commits.retry.exchange/q/rdm.saga.commits.retry');
  const flags = await inspect('/api/feature-flags');
  const streamQueueEnabled = Array.isArray(flags) && flags.some((flag: unknown) => {
    if (typeof flag !== 'object' || flag === null || !('name' in flag) || !('state' in flag)) return false;
    return flag.name === 'stream_queue' && flag.state === 'enabled';
  });
  return { queue, exchange, bindings, streamQueueEnabled };
}
