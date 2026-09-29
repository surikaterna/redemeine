import { createSagaCommitQueueTopology, provisionSagaTopology } from '../src/index';
import type { SagaCommitQueueTopologyConfig } from '../src/index';

const retryArguments = { 'x-queue-type': 'quorum', 'x-message-ttl': 5000, 'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': 'rdm.saga.commits', 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' };

function inspected() {
  return { queue: { name: 'rdm.saga.commits.retry', type: 'quorum', durable: true, auto_delete: false,
    exclusive: false, arguments: retryArguments },
  exchange: { name: 'rdm.saga.commits.retry.exchange', type: 'direct', durable: true, auto_delete: false, arguments: {} },
  bindings: [{ source: 'rdm.saga.commits.retry.exchange', destination: 'rdm.saga.commits.retry',
    destination_type: 'queue', routing_key: 'rdm.saga.commits.retry', arguments: {} }], streamQueueEnabled: true };
}

function fixture() {
  const calls: unknown[][] = [];
  const channel = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]); return { exchange: args[0] }; },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]); return { queue: args[0] }; },
    checkQueue: async (name: string) => { calls.push(['check', name]); return { queue: name }; },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]); return {}; }
  } as unknown as SagaCommitQueueTopologyConfig['channel'];
  const config: SagaCommitQueueTopologyConfig = {
    channel, sourceExchange: 'tapeworm.commits', collection: 'tw_orders_commits', partitions: ['p1', 'p2'],
    retryDelayMs: 5000, inspectRetry: async () => inspected()
  };
  return { calls, config, channel };
}

describe('production saga commit queue family', () => {
  it('declares input, DLQ and quorum retry with exact TTL and bindings before consume', async () => {
    const { calls, config } = fixture();
    const topology = createSagaCommitQueueTopology(config);
    await provisionSagaTopology(topology);
    expect(calls).toEqual([
      ['exchange', 'tapeworm.commits', 'headers', { durable: true, autoDelete: false }],
      ['exchange', 'rdm.saga.commits.dlx', 'direct', { durable: true, autoDelete: false }],
      ['queue', 'rdm.saga.commits.dlq', { durable: true, autoDelete: false, exclusive: false }],
      ['bind', 'rdm.saga.commits.dlq', 'rdm.saga.commits.dlx', 'rdm.saga.commits.dlq'],
      ['queue', 'rdm.saga.commits', { durable: true, autoDelete: false, exclusive: false,
        deadLetterExchange: 'rdm.saga.commits.dlx', deadLetterRoutingKey: 'rdm.saga.commits.dlq' }],
      ['check', 'rdm.saga.commits'],
      ['bind', 'rdm.saga.commits', 'tapeworm.commits', '', { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'p1' }],
      ['bind', 'rdm.saga.commits', 'tapeworm.commits', '', { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'p2' }],
      ['exchange', 'rdm.saga.commits.retry.exchange', 'direct', { durable: true, autoDelete: false }],
      ['queue', 'rdm.saga.commits.retry', { durable: true, autoDelete: false, exclusive: false, arguments: retryArguments }],
      ['bind', 'rdm.saga.commits.retry', 'rdm.saga.commits.retry.exchange', 'rdm.saga.commits.retry']
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/aggregateType|consume/);
  });

  it('binds tenant only on exact publisher match', async () => {
    const { calls, config } = fixture();
    await provisionSagaTopology(createSagaCommitQueueTopology({ ...config, tenant: 't1', publisherTenant: 't1' }));
    expect(calls).toContainEqual(['bind', 'rdm.saga.commits', 'tapeworm.commits', '',
      { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'p2', tenant: 't1' }]);
    calls.length = 0;
    await expect(provisionSagaTopology(createSagaCommitQueueTopology({ ...config, tenant: 't1' }))).rejects.toThrow('publisherTenant');
    expect(calls).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('rejects invalid TTL %s before declarations', (retryDelayMs) => {
    const { calls, config } = fixture();
    expect(() => createSagaCommitQueueTopology({ ...config, retryDelayMs })).toThrow('retryDelayMs');
    expect(calls).toEqual([]);
  });

  it.each(['type', 'ttl', 'strategy', 'overflow', 'dlx', 'exchange', 'binding', 'feature', 'policy'])
  ('fails closed on mismatched broker %s', async (mode) => {
    const { calls, config } = fixture();
    const state = inspected();
    const queue = state.queue;
    const altered = mode === 'type' ? { ...state, queue: { ...queue, type: 'classic' } } :
      mode === 'ttl' ? { ...state, queue: { ...queue, arguments: { ...retryArguments, 'x-message-ttl': 1 } } } :
      mode === 'strategy' ? { ...state, queue: { ...queue, arguments: { ...retryArguments, 'x-dead-letter-strategy': 'at-most-once' } } } :
      mode === 'overflow' ? { ...state, queue: { ...queue, arguments: { ...retryArguments, 'x-overflow': 'drop-head' } } } :
      mode === 'dlx' ? { ...state, queue: { ...queue, arguments: { ...retryArguments, 'x-dead-letter-exchange': 'wrong' } } } :
      mode === 'exchange' ? { ...state, exchange: { ...state.exchange, arguments: { alternate: 'other' } } } :
      mode === 'binding' ? { ...state, bindings: [] } :
      mode === 'feature' ? { ...state, streamQueueEnabled: false } :
      { ...state, queue: { ...queue, effective_policy_definition: { overflow: 'drop-head' } } };
    await expect(provisionSagaTopology(createSagaCommitQueueTopology({ ...config, inspectRetry: async () => altered })))
      .rejects.toThrow('consumer must not start');
    expect(calls.some((call) => call[0] === 'consume')).toBe(false);
  });

  it.each([403, 406])('fails closed on broker %s rejection', async (replyCode) => {
    const { calls, config } = fixture();
    const channel = { ...config.channel, assertQueue: async () => {
      const error = Object.assign(new Error('broker rejected'), { replyCode });
      throw error;
    } } as SagaCommitQueueTopologyConfig['channel'];
    await expect(provisionSagaTopology(createSagaCommitQueueTopology({ ...config, channel })))
      .rejects.toThrow('consumer must not start');
    expect(calls.some((call) => call[0] === 'consume')).toBe(false);
  });

  it.each([
    { collection: '' }, { partitions: [] }, { partitions: ['p1', ''] }, { partitions: ['p1', 'p1'] },
    { partitions: ['p3'], tenant: 'wrong', publisherTenant: 't1' }
  ])('rejects invalid scope or tenant before broker calls: %p', async (override) => {
    const { calls, config } = fixture();
    await expect(provisionSagaTopology(createSagaCommitQueueTopology({ ...config, ...override }))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
