import { bindSagaRegistrations } from '@redemeine/saga-runtime';
import type { SagaTurnRepository } from '@redemeine/saga-runtime';
import { openMongoSagaTurnRepository } from '@redemeine/saga-runtime-store-tapeworm';
import { connect, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { MongoClient } from 'mongodb';
import { createSagaConfirmedRepublisher, createSagaRabbitWorker, createSagaSourceEventProcessor } from '../src/index';
import { createCounters, createRealTable } from './fixtures';
import { provision, required } from './crashBroker';
import type { CrashSignal } from './crashIpc';
import { ChildStages } from './crashChildStages';
import { observedConsumerChannel } from './crashObservedChannel';

function send(message: CrashSignal): void {
  process.send?.(message);
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

async function main(stages: ChildStages): Promise<void> {
  const first = required('REDEMEINE_CRASH_MODE') === 'first';
  const client = new MongoClient(required('REDEMEINE_MONGO_URL'));
  let model: ChannelModel | undefined;
  try {
    await stages.run('mongo-connect', () => client.connect());
    const openedModel = await stages.run('amqp-connect', () => connect(required('REDEMEINE_CRASH_URL')));
    model = openedModel;
    const channel = await stages.run('consumer-channel', () => openedModel.createChannel());
    const scope = await stages.run('topology', () => provision(channel));
    const republisher = await stages.run('publisher', () => createSagaConfirmedRepublisher(openedModel, 5000));
    const base = await stages.run('partition-index', () => openMongoSagaTurnRepository(
      client.db(required('REDEMEINE_CRASH_DB')), required('REDEMEINE_CRASH_SAGA_PARTITION')));
    const repository = first ? injectAfterAppend(base) : base;
    const processor = await stages.run('registration', () => {
      const { table } = createRealTable('crash-proof', createCounters());
      return createSagaSourceEventProcessor(table, repository,
        { maxConflictRetries: 5, registrationForRoute: bindSagaRegistrations(table, table.registered!) });
    });
    const consumer = observedConsumerChannel(channel, send);
    const worker = createSagaRabbitWorker({ channel: consumer, queue: scope.worker.queue,
      source: scope.worker.source, limits: { maxBodyBytes: 100_000, maxEvents: 2, prefetch: 1, shutdownTimeoutMs: 2000 },
      processEvent: async (event) => {
        const outcomes = await processor(event);
        send({ kind: 'processed', messageId: event.eventId, statuses: outcomes.map((outcome) => outcome.status) });
        return outcomes;
      }, onSettlementError: failure => send(stages.failure(failure.error)),
      retry: { maxAttempts: 3, topology: scope.retry!, publisher: barrierPublisher(republisher, first), consumerChannel: consumer } });
    await stages.run('worker-start', () => worker.start());
    stages.phase = 'ready';
    send({ kind: 'ready' });
    stages.phase = 'worker-running';
    await new Promise<void>((resolve) => process.once('disconnect', resolve));
    await worker.stop();
    await republisher.close();
  } finally {
    await model?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

const stages = new ChildStages();
main(stages).catch(error => { send(stages.failure(error)); process.exitCode = 1; });
