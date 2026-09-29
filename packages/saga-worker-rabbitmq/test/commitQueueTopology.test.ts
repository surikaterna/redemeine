import { createSagaCommitQueueTopology, provisionSagaTopology } from '../src/index';
import type { SagaCommitQueueTopologyConfig } from '../src/index';

function fixture() {
  const calls: unknown[][] = [];
  const channel = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]); return { exchange: args[0] }; },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]); return { queue: args[0] }; },
    checkQueue: async (name: string) => { calls.push(['check', name]); return { queue: name }; },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]); return {}; }
  } as unknown as SagaCommitQueueTopologyConfig['channel'];
  const config: SagaCommitQueueTopologyConfig = {
    channel, sourceExchange: 'tapeworm.commits', collection: 'tw_orders_commits', partitions: ['p1', 'p2']
  };
  return { calls, config, channel };
}

describe('production saga commit queue family', () => {
  it('declares only input, DLQ and direct DLX; binds exact source scope before any consumer', async () => {
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
      ['bind', 'rdm.saga.commits', 'tapeworm.commits', '', { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'p2' }]
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/aggregateType|rdm\.saga\.commits\.retry|consume/);
  });

  it('binds tenant only on exact publisher match', async () => {
    const { calls, config } = fixture();
    await provisionSagaTopology(createSagaCommitQueueTopology({ ...config, tenant: 't1', publisherTenant: 't1' }));
    expect(calls.at(-1)).toEqual(['bind', 'rdm.saga.commits', 'tapeworm.commits', '',
      { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'p2', tenant: 't1' }]);
    calls.length = 0;
    await expect(provisionSagaTopology(createSagaCommitQueueTopology({ ...config, tenant: 't1' }))).rejects.toThrow('publisherTenant');
    expect(calls).toEqual([]);
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
