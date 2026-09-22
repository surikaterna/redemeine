import { connect } from 'amqplib';
import { MongoClient } from 'mongodb';
import type {
  CommitProjectionSourceCommitRequest,
  LoadProjectionSourceCommitSnapshotRequest,
  ProjectionSourceCommitStorePort,
  ProjectionSourceCoverageAdvance,
  ProjectionSourceOrderPort
} from '@redemeine/projection-runtime-core';
import { MongoProjectionStore } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import {
  createTapewormMongoCompleteCommitRangeReader,
  MongoProjectionTransportStore,
  ProjectionRabbitWorker,
  type ProjectionTransportDocument
} from '../src';
import {
  adaptChannel,
  PARTITION_ID,
  stackDefinitions,
  stackManifest,
  type StackEvent,
  type StackState
} from './realStackFixtures';
import type { ICommit } from 'tapeworm';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const mongoUri = required('REDEMEINE_MONGO_URI');
const rabbitUri = required('REDEMEINE_RABBIT_URI');
const databaseName = required('REDEMEINE_DATABASE');
const queue = required('REDEMEINE_QUEUE');
const scenario = required('REDEMEINE_SCENARIO');
const crashPoint = process.env.REDEMEINE_CRASH_POINT ?? '';
const expectedSettlement = process.env.REDEMEINE_EXPECTED_SETTLEMENT ?? 'ack';

async function killAt(client: MongoClient, point: string, details: Record<string, unknown>): Promise<never> {
  await client.db(databaseName).collection('crashBarriers').insertOne({ scenario, point, details, reachedAt: new Date() });
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => undefined);
}

class ObservedStore implements ProjectionSourceCommitStorePort<StackState> {
  private completed = 0;

  constructor(
    private readonly delegate: MongoProjectionStore<StackState>,
    private readonly client: MongoClient
  ) {}

  loadProjectionSourceCommitSnapshot(request: LoadProjectionSourceCommitSnapshotRequest) {
    return this.delegate.loadProjectionSourceCommitSnapshot(request);
  }

  async commitProjectionSourceCommit(request: CommitProjectionSourceCommitRequest<StackState>) {
    if (crashPoint === 'before_save') await killAt(this.client, crashPoint, { projection: request.projectionName });
    const result = await this.delegate.commitProjectionSourceCommit(request);
    await this.client.db(databaseName).collection('definitionAttempts').insertOne({
      scenario, projection: request.projectionName, sequence: request.commit.commitSequence,
      result: result.status, completedAt: new Date()
    });
    if (result.status === 'committed') this.completed += 1;
    if (crashPoint === 'after_p' && this.completed === 1) {
      await killAt(this.client, crashPoint, { projection: request.projectionName });
    }
    if (crashPoint === 'after_all' && this.completed === 4) {
      await killAt(this.client, crashPoint, { projection: request.projectionName });
    }
    return result;
  }
}

class ObservedSourceOrder implements ProjectionSourceOrderPort {
  constructor(
    private readonly delegate: MongoProjectionTransportStore,
    private readonly client: MongoClient
  ) {}

  admitForDispatch(commit: Parameters<ProjectionSourceOrderPort['admitForDispatch']>[0], queueBindingId: string) {
    return this.delegate.admitForDispatch(commit, queueBindingId);
  }

  async advanceCoverage(request: ProjectionSourceCoverageAdvance) {
    const coverage = await this.delegate.advanceCoverage(request);
    if (crashPoint === 'after_coverage') await killAt(this.client, crashPoint, { sequence: coverage.sequence });
    return coverage;
  }
}

async function run(): Promise<void> {
  const mongo = new MongoClient(mongoUri);
  const rabbit = await connect(rabbitUri);
  const channel = await rabbit.createChannel();
  await mongo.connect();
  const db = mongo.db(databaseName);
  const projectionStore = new MongoProjectionStore<StackState>({
    collection: db.collection(`${scenario}_documents`),
    linkCollection: db.collection(`${scenario}_links`),
    dedupeCollection: db.collection(`${scenario}_dedupe`),
    mongoClient: mongo
  });
  const manifest = stackManifest(queue);
  const transport = new MongoProjectionTransportStore({
    collection: db.collection<ProjectionTransportDocument>(`${scenario}_transport`),
    mongoClient: mongo,
    manifest
  });
  const rangeReader = createTapewormMongoCompleteCommitRangeReader<StackEvent>({
    collection: db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`),
    partitionId: PARTITION_ID
  });
  const coordinator = createProjectionCommitCoordinator<StackState>({
    queueBindingId: queue, manifest, definitions: stackDefinitions(),
    store: new ObservedStore(projectionStore, mongo),
    sourceOrder: new ObservedSourceOrder(transport, mongo), rangeReader,
    maxCommits: 100, maxBytes: 1_048_576, maxGapPages: 10, maxConflictRetries: 2
  });
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const worker = new ProjectionRabbitWorker({
    queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed',
    prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 60_000,
    coordinator,
    initialize: async () => { await transport.initialize(); await rangeReader.initialize(); },
    scheduleRetry: async (message, reason, minimumDelayMs) => {
      channel.sendToQueue(`${queue}.retry`, message.content, {
        persistent: true,
        ...(message.properties.messageId ? { messageId: message.properties.messageId } : {}),
        expiration: String(minimumDelayMs), headers: { reason }
      });
      return { durable: true, notBeforeEpochMs: Date.now() + minimumDelayMs };
    },
    observeSettlement: async (event) => {
      await db.collection('settlements').insertOne({ scenario, ...event, observedAt: new Date() });
      if (event.kind === expectedSettlement) finish();
    }
  });
  await worker.start(adaptChannel(channel));
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Child settlement timeout.')), 30_000))
  ]);
  await worker.stop();
  await channel.close();
  await rabbit.close();
  await mongo.close();
}

await run();
