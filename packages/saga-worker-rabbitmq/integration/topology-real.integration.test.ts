import { spawnSync } from 'node:child_process';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { SagaTurnPermanentError } from '@redemeine/saga-runtime';
import { createSagaCommitQueueTopology, createSagaRabbitWorker, provisionSagaTopology, type SagaRabbitWorkerOptions } from '../src/index';
import { expectBrokerRejection, publishConfirmedCommit } from './topologyAudit';
import { phaseStep } from './topologyPhase';
import { BrokerGate, waitForOwnedRabbitApp } from './rabbitAppReady';
import { waitForAmqpAfterRestart } from './amqpRestartProbe';
import { refreshedEndpoints } from './restartEndpoints';

let endpoints = { owner: process.env.REDEMEINE_TOPOLOGY_URL ?? '',
  restricted: process.env.REDEMEINE_TOPOLOGY_RESTRICTED_URL ?? '',
  management: process.env.REDEMEINE_TOPOLOGY_MANAGEMENT_URL ?? '' };
const container = process.env.REDEMEINE_TOPOLOGY_CONTAINER ?? '';
const containerId = process.env.REDEMEINE_TOPOLOGY_CONTAINER_ID ?? '';
const prefix = process.env.REDEMEINE_TOPOLOGY_RUN_ID ?? '';
const brokerGate = new BrokerGate();

async function management(path: string): Promise<unknown> {
  const url = new URL(path, endpoints.management).toString();
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

function productionConfig(channel: Channel) {
  const base = config(channel);
  const topology = createSagaCommitQueueTopology({
    channel, sourceExchange: base.topology.sourceExchange,
    collection: base.worker.source.collection, partitions: base.worker.source.partitions,
    tenant: 'tenant-a', publisherTenant: 'tenant-a'
  });
  return { topology, worker: { ...base.worker, queue: topology.worker.queue } };
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
  const model = await connect(endpoints.owner);
  return { model, channel: await model.createChannel() };
}

async function restart(): Promise<void> {
  await brokerGate.afterRestart(async () => {
    const result = spawnSync('docker', ['restart', container], { encoding: 'utf8', timeout: 90_000 });
    if (result.status !== 0) throw new Error('owned Rabbit restart failed');
  }, () => waitForOwnedRabbitApp(container, 90_000), async () => {
    endpoints = refreshedEndpoints(endpoints, container, containerId, prefix);
    await waitForAmqpAfterRestart(endpoints.owner, (error) => brokerGate.recordAmqpFailure(error));
  });
}

async function requireBrokerForNegative(): Promise<void> {
  await brokerGate.beforeNegative(() => waitForOwnedRabbitApp(container, 5_000));
}

async function publishBeforeRestart(): Promise<void> {
  const first = await phaseStep('setup-topology', 'declared-and-bound', async () => {
    const openedChannel = await opened();
    const { topology } = config(openedChannel.channel);
    await provisionSagaTopology(topology);
    await provisionSagaTopology(topology);
    return openedChannel;
  });
  const { topology } = config(first.channel);
  await phaseStep('inspect-topology', 'broker-inspected', () =>
    inspectWhenReady(topology.sourceExchange, topology.worker.queue.queue, topology.deadQueue));
  const pub = await phaseStep('publish-routed', 'routed-confirmed', () => first.model.createConfirmChannel());
  await phaseStep('publish-routed', 'routed-confirmed', () => publishConfirmedCommit(pub, topology.sourceExchange,
    { id: 'kept', partitionId: 'p1', collection: 'tw_source_commits', tenant: 'tenant-a' }, false));
  await phaseStep('publish-wrong-partition', 'mandatory-return', () => publishConfirmedCommit(pub, topology.sourceExchange,
    { id: 'wrong-partition', partitionId: 'p3', collection: 'tw_source_commits', tenant: 'tenant-a' }, true));
  await phaseStep('publish-wrong-tenant', 'mandatory-return', () => publishConfirmedCommit(pub, topology.sourceExchange,
    { id: 'wrong-tenant', partitionId: 'p1', collection: 'tw_source_commits', tenant: 'tenant-b' }, true));
  await phaseStep('publish-wrong-collection', 'mandatory-return', () => publishConfirmedCommit(pub, topology.sourceExchange,
    { id: 'wrong-collection', partitionId: 'p1', collection: 'other', tenant: 'tenant-a' }, true));
  await phaseStep('publish-routed', 'queue-ready-one', async () => {
    expect((await first.channel.checkQueue(topology.worker.queue.queue)).messageCount).toBe(1);
    await pub.close();
    await first.channel.close();
    await first.model.close();
  });
}

async function processHeldDelivery(channel: Channel, scope: { worker: SagaRabbitWorkerOptions }): Promise<void> {
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
  await phaseStep('held-unack', 'held-unack-one', async () => {
    await worker.start();
    await started;
    await waitForCounts(scope.worker.queue.queue, 0, 1);
    expect(processed).toBe(1);
    const before = await management(`/api/queues/%2F/${encodeURIComponent(scope.worker.queue.queue)}`);
    expect(before).not.toMatchObject({ message_stats: { ack: 1 } });
  });
  await phaseStep('ack-settlement', 'queue-acked-zero', async () => {
    release?.();
    await worker.stop();
    await waitForCounts(scope.worker.queue.queue, 0, 0);
    await waitForOneAck(scope.worker.queue.queue);
    expect(processed).toBe(1);
    expect((await channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(0);
    expect(await channel.get(scope.worker.queue.queue, { noAck: true })).toBe(false);
  });
}

async function deadLetterPoison(connection: Awaited<ReturnType<typeof opened>>,
  scope: { worker: SagaRabbitWorkerOptions; topology: { sourceExchange: string; deadQueue: string } }): Promise<void> {
  await phaseStep('dead-letter', 'dead-letter-visible', async () => {
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
  });
}

describe('owned Rabbit 4.1.4 durable topology', () => {
  beforeAll(() => {
    if (!endpoints.owner || !endpoints.restricted || !endpoints.management || !container || !containerId ||
        !/^topology-[a-f0-9]{32}$/.test(prefix)) throw new Error('owned runner environment required');
  });

  it('reconnects idempotently after broker restart, routes exact headers, ACKs and dead-letters permanent failure', async () => {
    await publishBeforeRestart();
    await phaseStep('broker-restart', 'same-volume-restarted', restart);

    const second = await phaseStep('restore-topology', 'queue-retained-one', async () => {
      const connection = await opened();
      const scope = config(connection.channel);
      await provisionSagaTopology(scope.topology);
      await inspectWhenReady(scope.topology.sourceExchange, scope.worker.queue.queue, scope.topology.deadQueue);
      expect((await connection.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(1);
      return connection;
    });
    const scope = await phaseStep('restore-topology', 'queue-retained-one', async () => config(second.channel));
    await processHeldDelivery(second.channel, scope);
    await deadLetterPoison(second, scope);
    await phaseStep('dead-letter', 'dead-letter-visible', async () => {
      await second.channel.close();
      await second.model.close();
    });
  }, 120_000);

  it.each(['type', 'durability', 'queue-args'])('fails closed on %s mismatch without starting consumer', async (mode) => {
    await phaseStep('mismatch-setup', 'broker-available', requireBrokerForNegative);
    const { fresh, topology, consume } = await phaseStep('mismatch-setup', 'declaration-conflict', async () => {
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
      return { fresh, topology, consume };
    });
    await phaseStep('mismatch-reply-406', 'reply-code-406', async () => {
      await expectBrokerRejection(fresh.channel, () => provisionSagaTopology(topology), 406);
      expect(consume).not.toHaveBeenCalled();
      await fresh.model.close();
    });
  });

  it('fails closed for restricted-user ACCESS_REFUSED before consumer start', async () => {
    await phaseStep('restricted-user-setup', 'broker-available', requireBrokerForNegative);
    const restricted = await phaseStep('restricted-user-setup', 'restricted-channel', () =>
      connect(endpoints.restricted));
    const { channel, consume } = await phaseStep('restricted-user-setup', 'restricted-channel', async () => {
      const channel = await restricted.createChannel();
      return { channel, consume: jest.spyOn(channel, 'consume') };
    });
    await phaseStep('restricted-reply-403', 'reply-code-403', async () => {
      await expectBrokerRejection(channel, () => provisionSagaTopology(config(channel).topology), 403);
      expect(consume).not.toHaveBeenCalled();
      await restricted.close();
    });
  });

  it('provisions the production names, retains confirmed commits over restart, ACKs and dead-letters', async () => {
    await phaseStep('setup-topology', 'broker-available', requireBrokerForNegative);
    const first = await opened();
    const scope = productionConfig(first.channel);
    await provisionSagaTopology(scope.topology);
    await provisionSagaTopology(scope.topology);
    const input = await management('/api/queues/%2F/rdm.saga.commits');
    const dead = await management('/api/queues/%2F/rdm.saga.commits.dlq');
    const dlx = await management('/api/exchanges/%2F/rdm.saga.commits.dlx');
    expect(input).toMatchObject({ durable: true, arguments: {
      'x-dead-letter-exchange': 'rdm.saga.commits.dlx', 'x-dead-letter-routing-key': 'rdm.saga.commits.dlq' } });
    expect(dead).toMatchObject({ durable: true });
    expect(dlx).toMatchObject({ durable: true, type: 'direct' });
    const bindings = await management(`/api/bindings/%2F/e/${encodeURIComponent(scope.topology.sourceExchange)}/q/rdm.saga.commits`);
    expect(bindings).toEqual(expect.arrayContaining(['p1', 'p2'].map((partitionId) =>
      expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId, tenant: 'tenant-a' } }))));
    expect(bindings).toHaveLength(2);
    const publisher = await first.model.createConfirmChannel();
    await publishConfirmedCommit(publisher, scope.topology.sourceExchange,
      { id: 'production-kept', collection: 'tw_source_commits', partitionId: 'p1', tenant: 'tenant-a' }, false);
    await publishConfirmedCommit(publisher, scope.topology.sourceExchange,
      { id: 'production-wrong', collection: 'tw_source_commits', partitionId: 'p3', tenant: 'tenant-a' }, true);
    expect((await first.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(1);
    await publisher.close();
    await first.model.close();
    await phaseStep('broker-restart', 'same-volume-restarted', restart);
    const second = await opened();
    try {
      const restored = productionConfig(second.channel);
      await provisionSagaTopology(restored.topology);
      expect((await second.channel.checkQueue(restored.worker.queue.queue)).messageCount).toBe(1);
      await processHeldDelivery(second.channel, restored);
      await deadLetterPoison(second, restored);
      await waitForCounts(restored.topology.deadQueue, 0, 0);
    } finally {
      await second.model.close();
    }
  }, 120_000);
});
