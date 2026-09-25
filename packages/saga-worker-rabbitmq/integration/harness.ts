import { once } from 'node:events';
import type { Event } from '@redemeine/kernel';
import {
  type CompiledSagaRoutingTable,
  createSagaAggregate,
  deriveSagaInstanceId,
  normalizeSagaCorrelation,
  type SagaTurnRepository
} from '@redemeine/saga-runtime';
import { openMongoSagaTurnRepository, type TapewormSagaEvent } from '@redemeine/saga-runtime-store-tapeworm';
import { type Channel, type ChannelModel, type ConfirmChannel, connect, type Options } from 'amqplib';
import { type Db, MongoClient } from 'mongodb';
import type { IBaseEvent, ICommit, IPersistencePartition } from 'tapeworm';
import { Dispatcher, type ResumeState } from 'tapeworm_dispatcher_mdb_rmq';
import MongoPersistence from 'tapeworm_persistence_store_mongodb';
import {
  createSagaRabbitWorker,
  createSagaSourceEventProcessor,
  type SagaRabbitChannel,
  type SagaRabbitSettlementError,
  type SagaRabbitWorker
} from '../src/index';
import type { RealSagaState } from './fixtures';
import { readRabbitQueueCounts } from './rabbitQueueCounts';

interface SourceEvent extends IBaseEvent {
  payload: unknown;
  aggregateType?: string;
  aggregateId?: string;
  metadata?: Record<string, unknown>;
}

interface SourceEventInput {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RealStack {
  readonly db: Db;
  readonly sourceCollection: string;
  readonly sourceExchange: string;
  readonly sourcePartitionId: string;
  readonly sourcePartition: IPersistencePartition<SourceEvent>;
  readonly dispatcher: Dispatcher;
  readonly publisherModel: ChannelModel;
  readonly publisher: ConfirmChannel;
  readonly dispatcherFailures: unknown[];
  close(): Promise<void>;
}

export interface ScenarioHarness {
  readonly partitionId: string;
  readonly partition: IPersistencePartition<TapewormSagaEvent>;
  readonly repository: SagaTurnRepository;
  readonly worker: SagaRabbitWorker;
  readonly channel: Channel;
  readonly queue: string;
  readonly deadQueue: string;
  readonly settlementErrors: SagaRabbitSettlementError[];
  close(): Promise<void>;
}

export interface ReplacementWorker {
  readonly worker: SagaRabbitWorker;
  close(): Promise<void>;
}

export interface ScenarioOptions {
  readonly repository?: (base: SagaTurnRepository) => SagaTurnRepository;
  readonly channel?: (base: Channel) => SagaRabbitChannel;
  readonly onSettlementError?: (failure: SagaRabbitSettlementError, base: Channel) => void | Promise<void>;
  readonly prefetch?: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function withDeadline<T>(label: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pollUntil(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

export async function connectRealStack(): Promise<RealStack> {
  const runId = required('REDEMEINE_REAL_RUN_ID');
  const client = new MongoClient(required('REDEMEINE_MONGO_URL'));
  await client.connect();
  const db = client.db(`redemeine_${runId}`);
  const sourcePartitionId = `source_${runId}`;
  const sourceCollection = `tw_${sourcePartitionId}_commits`;
  const sourceExchange = `source.${runId}`;
  const persistence = new MongoPersistence(db);
  const sourcePartition = typedPartition<SourceEvent>(await persistence.openPartition(sourcePartitionId));
  const publisherModel = await connect(required('REDEMEINE_RABBIT_URL'));
  const publisher = await publisherModel.createConfirmChannel();
  let resumeState: ResumeState | null = null;
  const dispatcherFailures: unknown[] = [];
  const dispatcher = new Dispatcher({
    mongodb: { db, collection: sourceCollection },
    rabbitmq: { uri: required('REDEMEINE_RABBIT_URL'), exchange: sourceExchange },
    resumeTokenStore: {
      load: async () => resumeState,
      save: async (state) => {
        resumeState = state;
      }
    }
  });
  dispatcher.on('error', (error) => dispatcherFailures.push(error));
  dispatcher.on('fatal', (error) => dispatcherFailures.push(error));
  const started = once(dispatcher, 'started');
  const dispatcherTask = dispatcher.start().catch((error: unknown) => {
    dispatcherFailures.push(error);
  });
  await withDeadline(
    'dispatcher startup',
    started.then(() => undefined)
  );
  return {
    db,
    sourceCollection,
    sourceExchange,
    sourcePartitionId,
    sourcePartition,
    dispatcher,
    publisherModel,
    publisher,
    dispatcherFailures,
    close: async () => {
      await dispatcher.stop();
      await dispatcherTask;
      await publisher.close();
      await publisherModel.close();
      await client.close();
    }
  };
}

export async function createScenario(
  stack: RealStack,
  label: string,
  table: CompiledSagaRoutingTable,
  options: ScenarioOptions = {}
): Promise<ScenarioHarness> {
  const safeLabel = label.replaceAll(/[^a-zA-Z0-9]/g, '_');
  const partitionId = `saga_${required('REDEMEINE_REAL_RUN_ID')}_${safeLabel}`;
  const persistence = new MongoPersistence(stack.db);
  const partition = typedPartition<TapewormSagaEvent>(await persistence.openPartition(partitionId));
  const baseRepository = await openMongoSagaTurnRepository(stack.db, partitionId);
  const repository = options.repository?.(baseRepository) ?? baseRepository;
  const model = await connect(required('REDEMEINE_RABBIT_URL'));
  const channel = await model.createChannel();
  const queue = `saga.${required('REDEMEINE_REAL_RUN_ID')}.${safeLabel}`;
  const deadQueue = `${queue}.dead`;
  const deadLetterExchange = `${queue}.dlx`;
  const queueOptions = {
    durable: false,
    autoDelete: false,
    exclusive: false,
    deadLetterExchange,
    deadLetterRoutingKey: 'dead'
  } satisfies Options.AssertQueue;
  await channel.assertExchange(stack.sourceExchange, 'headers', { durable: true });
  await channel.assertExchange(deadLetterExchange, 'direct', { durable: false, autoDelete: false });
  await channel.assertQueue(deadQueue, { durable: false, autoDelete: false, exclusive: false });
  await channel.bindQueue(deadQueue, deadLetterExchange, 'dead');
  await channel.assertQueue(queue, queueOptions);
  await channel.bindQueue(queue, stack.sourceExchange, '', {
    'x-match': 'all',
    collection: stack.sourceCollection,
    partitionId: stack.sourcePartitionId
  });
  const settlementErrors: SagaRabbitSettlementError[] = [];
  const worker = createSagaRabbitWorker({
    channel: options.channel?.(channel) ?? channel,
    queue: {
      queue,
      options: queueOptions,
      deadLetterExchange: { name: deadLetterExchange, type: 'direct', options: { durable: false, autoDelete: false } }
    },
    source: { collection: stack.sourceCollection, partitions: [stack.sourcePartitionId] },
    limits: { maxBodyBytes: 12 * 1024 * 1024, maxEvents: 20, prefetch: options.prefetch ?? 5, shutdownTimeoutMs: 5_000 },
    processEvent: createSagaSourceEventProcessor(table, repository, { maxConflictRetries: 5 }),
    onSettlementError: async (failure) => {
      settlementErrors.push(failure);
      await options.onSettlementError?.(failure, channel);
    }
  });
  await worker.start();
  return {
    partitionId,
    partition,
    repository,
    worker,
    channel,
    queue,
    deadQueue,
    settlementErrors,
    close: async () => {
      await worker.stop().catch(() => undefined);
      await channel.deleteQueue(queue).catch(() => undefined);
      await channel.deleteQueue(deadQueue).catch(() => undefined);
      await channel.deleteExchange(deadLetterExchange).catch(() => undefined);
      await channel.close().catch(() => undefined);
      await model.close().catch(() => undefined);
    }
  };
}

export async function appendSourceCommit(
  stack: RealStack,
  input: { readonly id: string; readonly streamId: string; readonly events: readonly SourceEventInput[] }
): Promise<ICommit<SourceEvent>> {
  const existing = await stack.sourcePartition.queryStream(input.streamId);
  const firstVersion = existing.reduce((count, commit) => count + commit.events.length, 0);
  const commit: ICommit<SourceEvent> = {
    id: input.id,
    partitionId: stack.sourcePartitionId,
    streamId: input.streamId,
    commitSequence: existing.length,
    events: input.events.map((event, index) => ({ ...event, version: firstVersion + index }))
  };
  const dispatched = waitForDispatched(stack.dispatcher, input.id);
  const appended = await stack.sourcePartition.append(commit);
  await dispatched;
  return appended;
}

function waitForDispatched(dispatcher: Dispatcher, commitId: string): Promise<void> {
  return withDeadline(
    `dispatcher commit ${commitId}`,
    new Promise((resolve) => {
      const listener = (commit: ICommit) => {
        if (commit.id !== commitId) return;
        dispatcher.off('dispatched', listener);
        resolve();
      };
      dispatcher.on('dispatched', listener);
    })
  );
}

export function sourceEvent(id: string, type: string, payload: unknown): SourceEventInput {
  return {
    id,
    type,
    payload,
    aggregateType: 'real-orders',
    aggregateId: typeof payload === 'object' && payload !== null && 'orderId' in payload ? String(payload.orderId) : 'unknown',
    metadata: { correlationId: `correlation-${id}` }
  };
}

type RequiredPartition = Pick<IPersistencePartition<IBaseEvent>, 'append' | 'getUndispatched' | 'markAsDispatched' | 'queryAll' | 'queryStream'>;

function typedPartition<TEvent extends IBaseEvent>(partition: RequiredPartition): IPersistencePartition<TEvent> {
  return {
    append: (commit) => partition.append(commit) as ReturnType<IPersistencePartition<TEvent>['append']>,
    queryAll: () => partition.queryAll() as ReturnType<IPersistencePartition<TEvent>['queryAll']>,
    queryStream: (streamId) => partition.queryStream(streamId) as ReturnType<IPersistencePartition<TEvent>['queryStream']>,
    getUndispatched: () => partition.getUndispatched() as ReturnType<IPersistencePartition<TEvent>['getUndispatched']>,
    markAsDispatched: (commit) => partition.markAsDispatched(commit) as ReturnType<IPersistencePartition<TEvent>['markAsDispatched']>
  };
}

export async function publishCommit(
  stack: RealStack,
  commit: ICommit,
  overrides: {
    readonly body?: unknown;
    readonly messageId?: string;
    readonly headers?: Record<string, unknown>;
  } = {}
): Promise<void> {
  stack.publisher.publish(stack.sourceExchange, '', Buffer.from(JSON.stringify(overrides.body ?? commit)), {
    contentType: 'application/json',
    deliveryMode: 2,
    messageId: overrides.messageId ?? commit.id,
    headers: overrides.headers ?? {
      collection: stack.sourceCollection,
      partitionId: commit.partitionId,
      streamId: commit.streamId
    }
  });
  await stack.publisher.waitForConfirms();
}

export async function streamCommits(harness: ScenarioHarness, instanceId: string): Promise<readonly ICommit[]> {
  return harness.partition.queryStream(instanceId);
}

export async function replayState(harness: ScenarioHarness, instanceId: string): Promise<RealSagaState> {
  const snapshot = await harness.repository.load(instanceId);
  const aggregate = createSagaAggregate();
  let state = aggregate.initialState;
  for await (const commit of snapshot.commits) {
    for (const stored of commit.events) state = aggregate.apply(state, stored as Event);
  }
  const businessState = state.businessState;
  if (!isRealSagaState(businessState)) throw new Error('expected replayed real saga state');
  return businessState;
}

function isRealSagaState(value: unknown): value is RealSagaState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'count' in value &&
    typeof value.count === 'number' &&
    'seen' in value &&
    Array.isArray(value.seen) &&
    value.seen.every((item) => typeof item === 'string')
  );
}

export function instanceId(sagaKey: string, orderId: string): string {
  return deriveSagaInstanceId(sagaKey, normalizeSagaCorrelation(orderId));
}

export function wrapRepository(base: SagaTurnRepository, append: SagaTurnRepository['append']): SagaTurnRepository {
  return {
    load: (id) => base.load(id),
    findCommit: (streamId, commitId) => base.findCommit(streamId, commitId),
    append
  };
}

export async function queueCounts(queue: string): Promise<{ ready: number; unacknowledged: number }> {
  return readRabbitQueueCounts({
    baseUrl: required('REDEMEINE_RABBIT_MANAGEMENT_URL'),
    username: required('REDEMEINE_RABBIT_USER'),
    password: required('REDEMEINE_RABBIT_PASSWORD'),
    queue
  });
}

export async function waitForQueueSettled(queue: string): Promise<void> {
  await pollUntil(`queue ${queue} settlement`, async () => {
    const counts = await queueCounts(queue);
    return counts.ready === 0 && counts.unacknowledged === 0;
  });
}

export async function waitForDeadLetter(harness: ScenarioHarness): Promise<void> {
  await pollUntil(`dead letter ${harness.deadQueue}`, async () => (await queueCounts(harness.deadQueue)).ready > 0);
}

export async function startReplacementWorker(stack: RealStack, harness: ScenarioHarness, table: CompiledSagaRoutingTable): Promise<ReplacementWorker> {
  const model = await connect(required('REDEMEINE_RABBIT_URL'));
  const channel = await model.createChannel();
  const worker = createSagaRabbitWorker({
    channel,
    queue: {
      queue: harness.queue,
      options: {
        durable: false,
        autoDelete: false,
        exclusive: false,
        deadLetterExchange: `${harness.queue}.dlx`,
        deadLetterRoutingKey: 'dead'
      },
      deadLetterExchange: { name: `${harness.queue}.dlx`, type: 'direct', options: { durable: false, autoDelete: false } }
    },
    source: { collection: stack.sourceCollection, partitions: [stack.sourcePartitionId] },
    limits: { maxBodyBytes: 12 * 1024 * 1024, maxEvents: 20, prefetch: 5, shutdownTimeoutMs: 5_000 },
    processEvent: createSagaSourceEventProcessor(table, harness.repository, { maxConflictRetries: 5 }),
    onSettlementError: () => undefined
  });
  await worker.start();
  return {
    worker,
    close: async () => {
      await worker.stop();
      await channel.deleteQueue(harness.queue);
      await channel.deleteQueue(harness.deadQueue);
      await channel.deleteExchange(`${harness.queue}.dlx`);
      await channel.close();
      await model.close();
    }
  };
}
