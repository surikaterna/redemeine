import type { SagaRabbitWorkerOptions, SagaTopologyChannel } from '../src/index';
import { createSagaRabbitWorker, provisionSagaTopology, SagaTopologyError } from '../src/index';
import { FakeChannel, limits, queue, source } from './helpers';

function fixture() {
  const calls: unknown[][] = [];
  let failure = '';
  const record = (name: string, ...args: unknown[]) => {
    calls.push([name, ...args]);
    if (failure === name) throw new Error('broker rejected declaration');
  };
  const channel = {
    assertExchange: async (name: string, type: string, options: unknown) => {
      record('exchange', name, type, options);
      return { exchange: name };
    },
    assertQueue: async (name: string, options: unknown) => {
      record('queue', name, options);
      return { queue: name };
    },
    checkQueue: async (name: string) => {
      record('check', name);
      return { queue: name };
    },
    bindQueue: async (name: string, exchange: string, key: string, headers?: unknown) => {
      record('bind', name, exchange, key, headers);
      return {};
    }
  } as unknown as SagaTopologyChannel;
  const worker = {
    channel,
    source: { collection: 'tw_orders_commits', partitions: ['a', 'b'] },
    queue: {
      queue: 'saga.input',
      options: { durable: true, autoDelete: false, exclusive: false, deadLetterExchange: 'saga.dlx', deadLetterRoutingKey: 'dead' },
      deadLetterExchange: { name: 'saga.dlx', type: 'direct', options: { durable: true, autoDelete: false } }
    }
  } as unknown as Pick<SagaRabbitWorkerOptions, 'channel' | 'queue' | 'source'>;
  const options = { channel, worker, sourceExchange: 'commits', deadQueue: 'saga.dead', deadRoutingKey: 'dead' };
  return { calls, options, failAt: (name: string) => { failure = name; } };
}

describe('single-node topology readiness', () => {
  it('uses the same channel and compatible declarations before the existing worker consumes', async () => {
    const channel = Object.assign(new FakeChannel(), {
      bindQueue: async () => ({}),
      checkQueue: async (name: string) => ({ queue: name, messageCount: 0, consumerCount: 0 })
    });
    const worker = createSagaRabbitWorker({ channel, queue, source, limits, processEvent: async () => [], onSettlementError: () => undefined });
    await provisionSagaTopology({ channel, worker: { channel, queue, source }, sourceExchange: 'source', deadQueue: 'dead', deadRoutingKey: queue.options.deadLetterRoutingKey });
    expect(channel.consumeCalls).toHaveLength(0);
    await worker.start();
    expect(channel.consumeCalls).toHaveLength(1);
    expect(channel.calls.filter((call) => call.startsWith('exchange:saga-turns.dlx'))).toHaveLength(2);
    await worker.stop();
  });
  it('declares durable publisher-compatible topology, binds exact partitions, and repeats idempotently', async () => {
    const { calls, options } = fixture();
    await provisionSagaTopology(options);
    const first = [...calls];
    expect(first).toEqual([
      ['exchange', 'commits', 'headers', { durable: true, autoDelete: false }],
      ['exchange', 'saga.dlx', 'direct', { durable: true, autoDelete: false }],
      ['queue', 'saga.dead', { durable: true, autoDelete: false, exclusive: false }],
      ['bind', 'saga.dead', 'saga.dlx', 'dead', undefined],
      ['queue', 'saga.input', options.worker.queue.options],
      ['check', 'saga.input'],
      ['bind', 'saga.input', 'commits', '', { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'a' }],
      ['bind', 'saga.input', 'commits', '', { 'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'b' }]
    ]);
    await provisionSagaTopology(options);
    expect(calls).toEqual([...first, ...first]);
    expect(JSON.stringify(calls)).not.toContain('aggregateType');
  });

  it('binds tenant only when the upstream dispatcher is configured with the same tenant', async () => {
    const { calls, options } = fixture();
    await provisionSagaTopology({ ...options, tenant: 'tenant-1', publisherTenant: 'tenant-1' });
    expect(calls.at(-1)).toEqual(['bind', 'saga.input', 'commits', '', {
      'x-match': 'all', collection: 'tw_orders_commits', partitionId: 'b', tenant: 'tenant-1'
    }]);
    await expect(provisionSagaTopology({ ...options, tenant: 'tenant-1' })).rejects.toThrow('publisherTenant');
  });

  it.each(['', ' ', 'saga.input'])('rejects invalid/colliding dead queue %s before broker calls', async (deadQueue) => {
    const { calls, options } = fixture();
    await expect(provisionSagaTopology({ ...options, deadQueue })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it('rejects duplicate partitions and unsupported aggregateType without broker calls', async () => {
    const { calls, options } = fixture();
    await expect(provisionSagaTopology({ ...options, worker: {
      ...options.worker, source: { collection: 'tw_orders_commits', partitions: ['a', 'a'] }
    } })).rejects.toThrow('duplicate partitionId');
    await expect(provisionSagaTopology({ ...options, worker: {
      ...options.worker, queue: { ...options.worker.queue, options: { ...options.worker.queue.options, aggregateType: 'orders' } }
    } })).rejects.toThrow('aggregateType');
    expect(calls).toEqual([]);
  });

  it.each(['exchange', 'queue', 'bind', 'check'])('fails closed on broker %s error before a consumer exists', async (name) => {
    const { calls, options, failAt } = fixture();
    failAt(name);
    await expect(provisionSagaTopology(options)).rejects.toBeInstanceOf(SagaTopologyError);
    expect(calls.some((call) => call[0] === 'consume')).toBe(false);
  });
});
