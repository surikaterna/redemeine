import { bindSagaRegistrations } from '@redemeine/saga-runtime';
import type { SagaTurnRepository } from '@redemeine/saga-runtime';
import { openMongoSagaTurnRepository } from '@redemeine/saga-runtime-store-tapeworm';
import { connect, type Channel, type ConsumeMessage } from 'amqplib';
import { MongoClient } from 'mongodb';
import { createSagaConfirmedRepublisher, createSagaRabbitWorker, createSagaSourceEventProcessor,
  type SagaRabbitChannel } from '../src/index';
import { createCounters, createRealTable } from './fixtures';
import { provision, required, retryQueue } from './crashBroker';
import type { CrashSignal } from './crashIpc';

function send(message: CrashSignal): void {
  process.send?.(message);
}

function deaths(value: unknown): unknown {
  if (!Array.isArray(value)) return value === undefined ? undefined : 'invalid-shape';
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('queue' in entry) ||
        !('reason' in entry) || !('count' in entry)) return 'invalid-entry';
    return { queue: entry.queue === retryQueue ? retryQueue : 'unexpected-queue',
      reason: entry.reason === 'expired' ? 'expired' : 'unexpected-reason',
      count: typeof entry.count === 'number' ? entry.count : 'invalid-count' };
  });
}

function observed(channel: Channel): SagaRabbitChannel {
  return {
    ack: (message, allUpTo) => {
      channel.ack(message, allUpTo);
      send({ kind: 'ack', messageId: message.properties.messageId });
    },
    nack: channel.nack.bind(channel),
    assertExchange: channel.assertExchange.bind(channel),
    assertQueue: channel.assertQueue.bind(channel),
    cancel: channel.cancel.bind(channel),
    prefetch: channel.prefetch.bind(channel),
    consume: (queue, callback, options) => channel.consume(queue, (message) => {
      if (message) send({ kind: 'delivery', messageId: message.properties.messageId,
        redelivered: message.fields.redelivered, attempt: message.properties.headers?.['rdm-saga-retry-attempt'],
        deaths: deaths(message.properties.headers?.['x-death']) });
      callback(message);
    }, options)
  };
}

function injectAfterAppend(base: SagaTurnRepository): SagaTurnRepository {
  let injected = false;
  return { partitionId: base.partitionId, load: base.load.bind(base), findCommit: base.findCommit.bind(base),
    assertCommitMaterial: base.assertCommitMaterial.bind(base), append: async (request) => {
      const result = await base.append(request);
      if (!injected && result.status === 'committed') {
        injected = true;
        throw new Error('injected transient AFTER durable append');
      }
      return result;
    } };
}

function barrierPublisher(republisher: Awaited<ReturnType<typeof createSagaConfirmedRepublisher>>, first: boolean) {
  return { retry: async (message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>) => {
    await republisher.retry(message, headers);
    const attempt = headers?.['rdm-saga-retry-attempt'];
    send({ kind: 'confirmed', messageId: message.properties.messageId,
      ...(typeof attempt === 'number' ? { attempt } : {}) });
    if (first) await new Promise<void>(() => undefined);
  }, deadLetter: async (message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>) => {
    await republisher.deadLetter(message, headers);
    send({ kind: 'dead', messageId: message.properties.messageId });
  }, close: () => republisher.close() };
}

async function main(): Promise<void> {
  const first = required('REDEMEINE_CRASH_MODE') === 'first';
  const client = new MongoClient(required('REDEMEINE_MONGO_URL'));
  await client.connect();
  const model = await connect(required('REDEMEINE_CRASH_URL'));
  const channel = await model.createChannel();
  try {
    const scope = await provision(channel);
    const republisher = await createSagaConfirmedRepublisher(model, 5000);
    const base = await openMongoSagaTurnRepository(client.db(required('REDEMEINE_CRASH_DB')),
      required('REDEMEINE_CRASH_SAGA_PARTITION'));
    const repository = first ? injectAfterAppend(base) : base;
    const { table } = createRealTable('crash-proof', createCounters());
    const processor = createSagaSourceEventProcessor(table, repository,
      { maxConflictRetries: 5, registrationForRoute: bindSagaRegistrations(table, table.registered!) });
    const worker = createSagaRabbitWorker({ channel: observed(channel), queue: scope.worker.queue,
      source: scope.worker.source, limits: { maxBodyBytes: 100_000, maxEvents: 2, prefetch: 1, shutdownTimeoutMs: 2000 },
      processEvent: async (event) => {
        const outcomes = await processor(event);
        send({ kind: 'processed', messageId: event.eventId, statuses: outcomes.map((outcome) => outcome.status) });
        return outcomes;
      }, onSettlementError: () => send({ kind: 'error' }),
      retry: { maxAttempts: 3, topology: scope.retry!, publisher: barrierPublisher(republisher, first), consumerChannel: channel } });
    await worker.start();
    send({ kind: 'ready' });
    await new Promise<void>((resolve) => process.once('disconnect', resolve));
    await worker.stop();
    await republisher.close();
  } finally {
    await model.close().catch(() => undefined);
    await client.close();
  }
}

main().catch(() => { send({ kind: 'error' }); process.exitCode = 1; });
