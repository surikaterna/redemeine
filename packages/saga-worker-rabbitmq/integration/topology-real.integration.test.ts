import { spawnSync } from 'node:child_process';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { SagaTurnPermanentError } from '@redemeine/saga-runtime';
import { createSagaCommitQueueTopology, createSagaConfirmedRepublisher, createSagaRabbitWorker, provisionSagaTopology,
  verifyRetryBroker, type SagaRabbitWorkerOptions } from '../src/index';
import { expectBrokerRejection, publishConfirmedCommit } from './topologyAudit';
import { phaseStep, withSafeClose } from './topologyPhase';
import { BrokerGate, waitForOwnedRabbitApp } from './rabbitAppReady';
import { waitForAmqpAfterRestart } from './amqpRestartProbe';
import { refreshedEndpoints } from './restartEndpoints';
import { inspectPersistedProductionTopology, inspectPublisherDelivery, publishTapewormCommit } from './productionTopologyAudit';
import type { ICommit } from 'tapeworm';
import { qualifyRestrictedTopology } from './restrictedTopologyAudit';
import { inspectRetryBroker } from './retryBrokerAudit';

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
    channel, sourceExchange: `${prefix}.production-source`,
    collection: 'tw_source_commits', partitions: ['p1', 'p2'],
    tenant: 'tenant-a', publisherTenant: 'tenant-a', retryDelayMs: 45_000,
    inspectRetry: () => inspectRetryBroker(management)
  });
  return { topology, worker: { ...base.worker, queue: topology.worker.queue } };
}

async function poll<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
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

async function publishProductionBeforeRestart(first: Awaited<ReturnType<typeof opened>>): Promise<ICommit> {
  const scope = productionConfig(first.channel);
  await phaseStep('production-provision', 'declared-and-bound', async () => {
    await provisionSagaTopology(scope.topology);
    await provisionSagaTopology(scope.topology);
  });
  await phaseStep('production-inspect', 'broker-inspected', () =>
    inspectPersistedProductionTopology(management, scope.topology.sourceExchange));
  const kept = await publishTapewormCommit(endpoints.owner, scope.topology.sourceExchange);
  await phaseStep('production-delivery', 'publisher-observed', () =>
    inspectPublisherDelivery(first.channel, scope.worker.queue.queue, kept));
  const publisher = await phaseStep('production-open', 'owner-channel-open', () => first.model.createConfirmChannel());
  await withSafeClose(async () => {
    await phaseStep('production-wrong-partition', 'mandatory-return', () => publishConfirmedCommit(publisher, scope.topology.sourceExchange,
      { id: 'production-wrong', collection: 'tw_source_commits', partitionId: 'p3', tenant: 'tenant-a' }, true));
    await phaseStep('production-wrong-collection', 'mandatory-return', () => publishConfirmedCommit(publisher, scope.topology.sourceExchange,
      { id: 'production-wrong-collection', collection: 'other', partitionId: 'p1', tenant: 'tenant-a' }, true));
    await phaseStep('production-wrong-tenant', 'mandatory-return', () => publishConfirmedCommit(publisher, scope.topology.sourceExchange,
      { id: 'production-wrong-tenant', collection: 'tw_source_commits', partitionId: 'p1', tenant: 'tenant-b' }, true));
  }, () => phaseStep('production-close', 'channel-closed', () => publisher.close()));
  await phaseStep('production-ready', 'queue-ready-one', async () => {
    await waitForCounts(scope.worker.queue.queue, 1, 0);
    expect((await first.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(1);
  });
  return kept;
}

async function inspectProductionAfterRestart(second: Awaited<ReturnType<typeof opened>>, kept: ICommit): Promise<void> {
  const restored = productionConfig(second.channel);
  await phaseStep('production-retained-topology', 'retained-before-provision', async () => {
    await waitForCounts(restored.worker.queue.queue, 1, 0);
    await inspectPersistedProductionTopology(management, restored.topology.sourceExchange);
  });
  await phaseStep('production-retained-message', 'publisher-observed', async () => {
    await inspectPublisherDelivery(second.channel, restored.worker.queue.queue, kept);
    await waitForCounts(restored.worker.queue.queue, 1, 0);
  });
  await phaseStep('production-reprovision', 'declared-and-bound', () => provisionSagaTopology(restored.topology));
  await phaseStep('production-held-ack', 'queue-acked-zero', async () => {
    expect((await second.channel.checkQueue(restored.worker.queue.queue)).messageCount).toBe(1);
    await processHeldDelivery(second.channel, restored);
  });
  await phaseStep('production-dlq', 'dead-letter-visible', async () => {
    await deadLetterPoison(second, restored);
    await waitForCounts(restored.topology.deadQueue, 0, 0);
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
    await qualifyRestrictedTopology({
      health: requireBrokerForNegative,
      connect: () => connect(endpoints.restricted),
      provision: (channel) => provisionSagaTopology(config(channel).topology)
    });
  }, 20_000);

  it('provisions the production names, retains confirmed commits over restart, ACKs and dead-letters', async () => {
    await phaseStep('production-health', 'broker-available', requireBrokerForNegative);
    const first = await phaseStep('production-open', 'owner-channel-open', opened);
    const kept = await withSafeClose(() => publishProductionBeforeRestart(first),
      () => phaseStep('production-close', 'channel-closed', () => first.model.close()));
    await phaseStep('broker-restart', 'same-volume-restarted', restart);
    const second = await phaseStep('production-reopen', 'owner-channel-open', opened);
    await withSafeClose(() => inspectProductionAfterRestart(second, kept),
      () => phaseStep('production-close', 'channel-closed', () => second.model.close()));
  }, 120_000);

  it('confirms a mandatory persistent retry, retains it across restart, then returns after queue TTL', async () => {
    await phaseStep('retry-health', 'broker-available', requireBrokerForNegative);
    const first = await opened();
    let sentAt = 0;
    await withSafeClose(async () => {
      const topology = productionConfig(first.channel).topology;
      await phaseStep('retry-provision', 'quorum-inspected', () => provisionSagaTopology(topology));
      verifyRetryBroker(await inspectRetryBroker(management), topology.retry!);
      const pub = await first.model.createConfirmChannel();
      await withSafeClose(async () => {
        await publishConfirmedCommit(pub, topology.sourceExchange,
          { id: 'retry-held', partitionId: 'p1', collection: 'tw_source_commits', tenant: 'tenant-a' }, false);
        const original = await poll(async () => await first.channel.get('rdm.saga.commits', { noAck: false }) || null, 'retry original');
        const republisher = await createSagaConfirmedRepublisher(first.model, 5000);
        await withSafeClose(async () => {
          sentAt = Date.now();
          await republisher.retry({ ...original, fields: { ...original.fields, consumerTag: 'basic.get' } } satisfies ConsumeMessage);
          await waitForCounts('rdm.saga.commits.retry', 1, 0);
          await waitForCounts('rdm.saga.commits', 0, 1);
          first.channel.ack(original);
        }, () => republisher.close());
      }, () => pub.close());
    }, () => first.model.close());
    await phaseStep('retry-restart', 'same-volume-restarted', restart);
    const second = await opened();
    await withSafeClose(async () => {
      const topology = productionConfig(second.channel).topology;
      verifyRetryBroker(await inspectRetryBroker(management), topology.retry!);
      expect((await second.channel.checkQueue('rdm.saga.commits.retry')).messageCount).toBe(1);
      await phaseStep('retry-expiry', 'input-visible-after-ttl', async () => {
        const returned = await poll(async () => await second.channel.get('rdm.saga.commits', { noAck: false }) || null,
          'retry returned to input', 70_000);
        expect(Date.now() - sentAt).toBeGreaterThanOrEqual(44_000);
        expect(returned.properties.messageId).toBe('retry-held');
        expect(returned.properties.deliveryMode).toBe(2);
        second.channel.ack(returned);
      });
      const pub = await second.model.createConfirmChannel();
      await withSafeClose(async () => {
        const returned: string[] = [];
        pub.on('return', (delivery) => returned.push(delivery.properties.messageId ?? ''));
        await new Promise<void>((resolve, reject) => {
          pub.publish('rdm.saga.commits.retry.exchange', 'wrong-key', Buffer.from('unroutable'),
            { messageId: 'wrong-key', deliveryMode: 2, mandatory: true }, (error) => error ? reject(error) : resolve());
        });
        expect(returned).toEqual(['wrong-key']);
      }, () => pub.close());
    }, () => second.model.close());
  }, 180_000);

  it('rejects changed fixed retry TTL with broker 406 before any consume', async () => {
    await phaseStep('retry-health', 'broker-available', requireBrokerForNegative);
    const connection = await opened();
    const consume = jest.spyOn(connection.channel, 'consume');
    const topology = productionConfig(connection.channel).topology;
    await phaseStep('retry-mismatch', 'reply-code-406', async () => {
      await expectBrokerRejection(connection.channel, () => provisionSagaTopology({ ...topology,
        retry: { ...topology.retry!, delayMs: 45_001 } }), 406);
      expect(consume).not.toHaveBeenCalled();
    });
    await connection.model.close();
  });
});
