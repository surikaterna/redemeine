import { spawnSync } from 'node:child_process';
import { connect, type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { SagaTurnPermanentError } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, provisionSagaTopology, type SagaRabbitWorkerOptions } from '../src/index';

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
    expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId: 'p1' } }),
    expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId: 'p2' } })
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
    topology: { channel, worker, sourceExchange: `${prefix}.source`, deadQueue: `${prefix}.dead`, deadRoutingKey: 'dead' }
  };
}

function publish(channel: ConfirmChannel, id: string, partitionId: string, collection = 'tw_source_commits'): void {
  const streamId = `stream-${id}`;
  const body = { id, partitionId, streamId, commitSequence: 0, createDateTime: new Date().toISOString(),
    events: [{ id: `event-${id}`, type: 'Created', version: 0, payload: { id } }] };
  channel.publish(`${prefix}.source`, '', Buffer.from(JSON.stringify(body)), {
    contentType: 'application/json', deliveryMode: 2, messageId: id,
    headers: { collection, partitionId, streamId }
  });
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
  publish(pub, 'kept', 'p1');
  publish(pub, 'wrong-partition', 'p3');
  publish(pub, 'wrong-collection', 'p1', 'other');
  await pub.waitForConfirms();
  expect((await first.channel.checkQueue(topology.worker.queue.queue)).messageCount).toBe(1);
  await pub.close();
  await first.channel.close();
  await first.model.close();
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
    let resolveProcessing: (() => void) | undefined;
    let processingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { processingStarted = resolve; });
    const processing = new Promise<void>((resolve) => { resolveProcessing = resolve; });
    const worker = createSagaRabbitWorker({ ...scope.worker, processEvent: async () => {
      processingStarted?.();
      await processing;
      return [];
    } });
    await worker.start();
    await poll(async () => (await second.channel.checkQueue(scope.worker.queue.queue)).consumerCount === 1 ? true : null, 'consumer');
    await started;
    expect((await second.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(0);
    resolveProcessing?.();
    await worker.stop();
    expect((await second.channel.checkQueue(scope.worker.queue.queue)).messageCount).toBe(0);
    expect(await second.channel.get(scope.worker.queue.queue, { noAck: true })).toBe(false);

    const permanent = createSagaRabbitWorker({ ...scope.worker, processEvent: async () => {
      throw new SagaTurnPermanentError('test_poison', 'permanent', {});
    } });
    await permanent.start();
    const publisher = await second.model.createConfirmChannel();
    publish(publisher, 'poison', 'p2');
    await publisher.waitForConfirms();
    const dead = await poll(async () => (await second.channel.get(scope.topology.deadQueue, { noAck: false })) || null, 'dead-letter');
    expect(dead.properties.messageId).toBe('poison');
    second.channel.ack(dead);
    await permanent.stop();
    await publisher.close();
    await second.channel.close();
    await second.model.close();
  }, 120_000);

  it.each(['type', 'durability', 'queue-args', 'permission'])('fails closed on %s mismatch without starting consumer', async (mode) => {
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
    const options = config(fresh.channel);
    const topology = mode === 'type' || mode === 'durability' ? { ...options.topology, sourceExchange: name } :
      mode === 'queue-args' ? { ...options.topology, worker: { ...options.worker, queue: { ...options.worker.queue, queue: name } } } : options.topology;
    if (mode === 'permission') {
      const restricted = await connect(process.env.REDEMEINE_TOPOLOGY_RESTRICTED_URL ?? '');
      const restrictedChannel = await restricted.createChannel();
      const restrictedOptions = config(restrictedChannel);
      await expect(provisionSagaTopology(restrictedOptions.topology)).rejects.toThrow('consumer must not start');
      expect(restrictedOptions.worker.channel).toBe(restrictedChannel);
      await restricted.close();
    } else {
      await expect(provisionSagaTopology(topology)).rejects.toThrow('consumer must not start');
    }
    expect(options.worker.channel).toBe(fresh.channel);
    await fresh.model.close();
  });
});
