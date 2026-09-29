import { spawnSync } from 'node:child_process';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { SagaTurnPermanentError } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, provisionSagaTopology, type SagaRabbitWorkerOptions } from '../src/index';
import { expectBrokerRejection, publishConfirmedCommit } from './topologyAudit';

const url = process.env.REDEMEINE_TOPOLOGY_URL ?? '';
const container = process.env.REDEMEINE_TOPOLOGY_CONTAINER ?? '';
const prefix = process.env.REDEMEINE_TOPOLOGY_RUN_ID ?? '';

async function management(path: string): Promise<unknown> {
  const url = `${process.env.REDEMEINE_TOPOLOGY_MANAGEMENT_URL}${path}`;
  const auth = Buffer.from('topology_owner:topology_owner_password').toString('base64');
  const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  if (!response.ok) throw new Error(`Rabbit management inspection failed: HTTP ${response.status}`);
  return response.json();
}

async function queueMetrics(queue: string): Promise<{ ready: number; unacked: number } | null> {
  const data = await management(`/api/queues/%2F/${encodeURIComponent(queue)}`);
  if (typeof data !== 'object' || data === null || !('messages_ready' in data) || !('messages_unacknowledged' in data)) return null;
  const { messages_ready: ready, messages_unacknowledged: unacked } = data;
  if (typeof ready !== 'number' || typeof unacked !== 'number' || !Number.isSafeInteger(ready) || !Number.isSafeInteger(unacked)) return null;
  return { ready, unacked };
}

async function waitForCounts(queue: string, ready: number, unacked: number): Promise<void> {
  await poll(async () => {
    const counts = await queueMetrics(queue);
    return counts?.ready === ready && counts.unacked === unacked ? true : null;
  }, `queue ${queue} ready=${ready} unacked=${unacked}`);
}

async function waitForOneAck(queue: string): Promise<void> {
  await poll(async () => {
    const data = await management(`/api/queues/%2F/${encodeURIComponent(queue)}`);
    if (typeof data !== 'object' || data === null || !('message_stats' in data)) return null;
    const stats = data.message_stats;
    if (typeof stats !== 'object' || stats === null || !('ack' in stats)) return null;
    return stats.ack === 1 ? true : null;
  }, `queue ${queue} single ACK`);
}

async function inspectTopology(sourceExchange: string, inputQueue: string, deadQueue: string): Promise<void> {
  const input = await management(`/api/queues/%2F/${encodeURIComponent(inputQueue)}`);
  const dead = await management(`/api/queues/%2F/${encodeURIComponent(deadQueue)}`);
  const source = await management(`/api/exchanges/%2F/${encodeURIComponent(sourceExchange)}`);
  const dlx = await management(`/api/exchanges/%2F/${encodeURIComponent(`${prefix}.dlx`)}`);
  expect(input).toMatchObject({ durable: true, arguments: { 'x-dead-letter-exchange': `${prefix}.dlx`, 'x-dead-letter-routing-key': 'dead' } });
  expect(dead).toMatchObject({ durable: true });
  expect(source).toMatchObject({ type: 'headers', durable: true });
  expect(dlx).toMatchObject({ type: 'direct', durable: true });
  const bindings = await management(`/api/bindings/%2F/e/${encodeURIComponent(sourceExchange)}/q/${encodeURIComponent(inputQueue)}`);
  expect(bindings).toEqual(expect.arrayContaining([
    expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId: 'p1', tenant: 'tenant-a' } }),
    expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId: 'p2', tenant: 'tenant-a' } })
  ]));
  expect(bindings).toHaveLength(2);
}

async function inspectWhenReady(sourceExchange: string, inputQueue: string, deadQueue: string): Promise<void> {
  await poll(async () => {
    try {
      await inspectTopology(sourceExchange, inputQueue, deadQueue);
      return true;
    } catch {
      return null;
    }
  }, 'broker topology inspection');
}

function config(channel: Channel) {
  const worker = {
    channel,
    queue: {
      queue: `${prefix}.input`,
      options: { durable: true, autoDelete: false, exclusive: false, deadLetterExchange: `${prefix}.dlx`, deadLetterRoutingKey: 'dead' },
      deadLetterExchange: { name: `${prefix}.dlx`, type: 'direct', options: { durable: true, autoDelete: false } }
    },
    source: { collection: 'tw_source_commits', partitions: ['p1', 'p2'] },
    limits: { maxBodyBytes: 100_000, maxEvents: 2, prefetch: 1, shutdownTimeoutMs: 2000 },
    processEvent: async () => [],
    onSettlementError: () => undefined
  } satisfies SagaRabbitWorkerOptions;
  return {
    worker,
    topology: { channel, worker, sourceExchange: `${prefix}.source`, deadQueue: `${prefix}.dead`, deadRoutingKey: 'dead',
      tenant: 'tenant-a', publisherTenant: 'tenant-a' }
  };
}

async function poll<T>(probe: () => Promise<T | null>, label: string): Promise<T> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const result = await probe();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

async function opened(): Promise<{ model: ChannelModel; channel: Channel }> {
  const model = await connect(url);
  return { model, channel: await model.createChannel() };
}

async function restart(): Promise<void> {
  const result = spawnSync('docker', ['restart', container], { encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0) throw new Error(`owned Rabbit restart failed: ${result.stderr}`);
  await poll(async () => {
    try {
      const connection = await opened();
      await connection.channel.close();
      await connection.model.close();
      return true;
    } catch {
      return null;
    }
  }, 'Rabbit restart');
}

async function publishBeforeRestart(): Promise<void> {
  const first = await opened();
  const { topology } = config(first.channel);
  await provisionSagaTopology(topology);
  await provisionSagaTopology(topology);
  await inspectWhenReady(topology.sourceExchange, topology.worker.queue.queue, topology.deadQueue);
  const pub = await first.model.createConfirmChannel();
  await publishConfirmedCommit(pub, topology.sourceExchange, { id: 'kept', partitionId: 'p1', collection: 'tw_source_commits', tenant: 'tenant-a' }, false);
  await publishConfirmedCommit(pub, topology.sourceExchange, { id: 'wrong-partition', partitionId: 'p3', collection: 'tw_source_commits', tenant: 'tenant-a' }, true);
  await publishConfirmedCommit(pub, topology.sourceExchange, { id: 'wrong-tenant', partitionId: 'p1', collection: 'tw_source_commits', tenant: 'tenant-b' }, true);
  await publishConfirmedCommit(pub, topology.sourceExchange, { id: 'wrong-collection', partitionId: 'p1', collection: 'other', tenant: 'tenant-a' }, true);
  expect((await first.channel.checkQueue(topology.worker.queue.queue)).messageCount).toBe(1);
  await pub.close();
  await first.channel.close();
  await first.model.close();
}

async function processHeldDelivery(channel: Channel, scope: ReturnType<typeof config>): Promise<void> {
  let release: (() => void) | undefined;
  let began: (() => void) | undefined;
  let processed = 0;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const worker = createSagaRabbitWorker({ ...scope.worker, processEvent: async () => {
    processed++;
    began?.();
    await barrier;
    return [];
  } });
  await worker.start();
  await started;
  await waitForCounts(scope.worker.queue.queue, 0, 1);
  expect(processed).toBe(1);
  const before = await management(`/api/queues/%2F/${encodeURIComponent(scope.worker.queue.queue)}`);
  expect(before).not.toMatchObject({ message_stats: { ack: 1 } });
  release?.();
  await worker.stop();
  await waitForCounts(scope.worker.queue.queue, 0, 0);
  await waitForOneAck(scope.worker.queue.queue);
  expect(processed).toBe(1);
  expect((await channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(0);
  expect(await channel.get(scope.worker.queue.queue, { noAck: true })).toBe(false);
}

async function deadLetterPoison(connection: Awaited<ReturnType<typeof opened>>, scope: ReturnType<typeof config>): Promise<void> {
  const worker = createSagaRabbitWorker({ ...scope.worker, processEvent: async () => {
    throw new SagaTurnPermanentError('test_poison', 'permanent', {});
  } });
  await worker.start();
  const publisher = await connection.model.createConfirmChannel();
  await publishConfirmedCommit(publisher, scope.topology.sourceExchange,
    { id: 'poison', partitionId: 'p2', collection: 'tw_source_commits', tenant: 'tenant-a' }, false);
  const dead = await poll(async () => (await connection.channel.get(scope.topology.deadQueue, { noAck: false })) || null, 'dead-letter');
  expect(dead.properties.messageId).toBe('poison');
  connection.channel.ack(dead);
  await worker.stop();
  await publisher.close();
}

describe('owned Rabbit 4.1.4 durable topology', () => {
  beforeAll(() => {
    if (!url || !container || !/^topology-[a-z0-9-]+$/.test(prefix)) throw new Error('owned runner environment required');
  });

  it('reconnects idempotently after broker restart, routes exact headers, ACKs and dead-letters permanent failure', async () => {
    await publishBeforeRestart();
    await restart();

    const second = await opened();
    const scope = config(second.channel);
    await provisionSagaTopology(scope.topology);
    await inspectWhenReady(scope.topology.sourceExchange, scope.worker.queue.queue, scope.topology.deadQueue);
    expect((await second.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(1);
    await processHeldDelivery(second.channel, scope);
    await deadLetterPoison(second, scope);
    await second.channel.close();
    await second.model.close();
  }, 120_000);

  it.each(['type', 'durability', 'queue-args'])('fails closed on %s mismatch without starting consumer', async (mode) => {
    const { model, channel } = await opened();
    const scoped = config(channel);
    const name = `${prefix}.${mode}`;
    if (mode === 'type') await channel.assertExchange(name, 'fanout', { durable: true });
    if (mode === 'durability') await channel.assertExchange(name, 'headers', { durable: false });
    if (mode === 'queue-args') {
      await channel.assertExchange(scoped.topology.sourceExchange, 'headers', { durable: true });
      await channel.assertQueue(name, { durable: true, arguments: { 'x-message-ttl': 1000 } });
    }
    await channel.close();
    await model.close();
    const fresh = await opened();
    const consume = jest.spyOn(fresh.channel, 'consume');
    const options = config(fresh.channel);
    const topology = mode === 'type' || mode === 'durability' ? { ...options.topology, sourceExchange: name } :
      mode === 'queue-args' ? { ...options.topology, worker: { ...options.worker, queue: { ...options.worker.queue, queue: name } } } : options.topology;
    await expectBrokerRejection(fresh.channel, () => provisionSagaTopology(topology), 406);
    expect(consume).not.toHaveBeenCalled();
    await fresh.model.close();
  });

  it('fails closed for restricted-user ACCESS_REFUSED before consumer start', async () => {
    const restricted = await connect(process.env.REDEMEINE_TOPOLOGY_RESTRICTED_URL ?? '');
    const channel = await restricted.createChannel();
    const consume = jest.spyOn(channel, 'consume');
    await expectBrokerRejection(channel, () => provisionSagaTopology(config(channel).topology), 403);
    expect(consume).not.toHaveBeenCalled();
    await restricted.close();
  });
});
