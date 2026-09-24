import { connect, type ConfirmChannel } from 'amqplib';
import { MongoClient, type Db } from 'mongodb';
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
  SourceTailPoller,
  type AcceptedBaseline,
  type ProjectionTransportDocument,
  type ProjectionRabbitRetryReceipt,
  type RabbitDelivery
} from '../src';
import {
  adaptChannel,
  PARTITION_ID,
  SOURCE_ID,
  stackDefinitions,
  stackManifest,
  type StackEvent,
  type StackState
} from './realStackFixtures';
import type { ICommit } from 'tapeworm';
import { publishConfirmedRetry } from './confirmedRetryPublisher';
import { cleanupChildResources } from './childCleanup';
import { waitForSettlement } from './settlementWait';

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

  loadProjectionMigrationReceipt(request: {
    migrationId: string; manifestDigest: `sha256:${string}`; projectionName: string; projectionGeneration: string; sourceId: string;
  }) {
    return this.delegate.loadProjectionMigrationReceipt(request);
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

function acceptedBaseline(manifest: ReturnType<typeof stackManifest>): AcceptedBaseline {
  return { version: 2, kind: 'existing', queueBindingId: queue,
    manifestId: manifest.manifestId, registryGeneration: manifest.registryGeneration,
    sourceId: SOURCE_ID, lastAcceptedSequence: -1, startAnchor: 0, operator: 'real-stack-operator',
    acceptedAt: '2026-09-24T00:00:00Z', acknowledgesUnverifiedHistoryAndCutoff: true,
    oldWriterStoppedBy: 'real-stack-operator', oldWriterStoppedAt: '2026-09-24T00:00:00Z',
    queueTailReadinessReference: 'indexed-source-polling',
    strategyScope: stackDefinitions().map(({ generation, definition }) => ({ projectionName: definition.name,
      generation, strategy: definition.deduplication.strategy,
      stableSingleTarget: definition.deduplication.strategy === 'in_document' })) };
}

async function scheduleConfirmedRetry(db: Db, channel: ConfirmChannel, message: RabbitDelivery,
  reason: string, minimumDelayMs: number): Promise<ProjectionRabbitRetryReceipt> {
  const publication = await publishConfirmedRetry(channel, `${queue}.retry`, message.content, {
    messageId: message.properties.messageId ?? `${scenario}-retry`,
    expiration: String(minimumDelayMs), headers: { reason }
  });
  await db.collection('retryPublications').insertOne({ scenario, queue: `${queue}.retry`,
    persistent: true, mandatory: true, topologyVerified: true, ...publication });
  return { durable: true, notBeforeEpochMs: Date.now() + minimumDelayMs };
}

function createWorker(mongo: MongoClient, channel: ConfirmChannel, finish: () => void): ProjectionRabbitWorker {
  const db = mongo.db(databaseName);
  const projectionStore = new MongoProjectionStore<StackState>({
    collection: db.collection(`${scenario}_documents`),
    linkCollection: db.collection(`${scenario}_links`),
    dedupeCollection: db.collection(`${scenario}_dedupe`),
    mongoClient: mongo
  });
  const manifest = stackManifest(queue);
  const rangeReader = createTapewormMongoCompleteCommitRangeReader<StackEvent>({
    collection: db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`), partitionId: PARTITION_ID
  });
  const transport = new MongoProjectionTransportStore({
    collection: db.collection<ProjectionTransportDocument>(`${scenario}_transport`),
    mongoClient: mongo,
    manifest, cutoverReadiness: { reader: rangeReader }
  });
  const coordinator = createProjectionCommitCoordinator<StackState>({
    queueBindingId: queue, manifest, definitions: stackDefinitions(),
    store: new ObservedStore(projectionStore, mongo),
    sourceOrder: new ObservedSourceOrder(transport, mongo), rangeReader,
    maxCommits: 100, maxBytes: 1_048_576, maxGapPages: 10, maxConflictRetries: 2
  });
  const baseline = acceptedBaseline(manifest);
  const sourceTail = new SourceTailPoller({ queueId: queue, sourceIds: [SOURCE_ID],
    reader: rangeReader, transport, coordinator, maxCommits: 100, maxBytes: 1_048_576,
    maxPages: 10, intervalMs: 200, onFailure: (error) => process.stderr.write(`source tail: ${error.message}\n`) });
  return new ProjectionRabbitWorker({
    queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed',
    prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 60_000,
    coordinator,
    sourceTail,
    initialize: async () => {
      await transport.initialize(); await rangeReader.initialize();
      if (!await transport.readAcceptedBaseline(queue, SOURCE_ID)) await transport.installAcceptedBaseline(baseline);
    },
    scheduleRetry: (message, reason, minimumDelayMs) => scheduleConfirmedRetry(db, channel, message, reason, minimumDelayMs),
    observeSettlement: async (event) => {
      await db.collection('settlements').insertOne({ scenario, ...event, observedAt: new Date() });
      if (event.kind === expectedSettlement) finish();
    }
  });
}

async function run(): Promise<void> {
  const mongo = new MongoClient(mongoUri);
  let rabbit: Awaited<ReturnType<typeof connect>> | undefined;
  let channel: ConfirmChannel | undefined;
  let worker: ProjectionRabbitWorker | undefined;
  let failure: unknown;
  try {
    await mongo.connect();
    rabbit = await connect(rabbitUri);
    channel = await rabbit.createConfirmChannel();
    await channel.assertQueue(`${queue}.retry`, { durable: true, deadLetterExchange: '', deadLetterRoutingKey: queue });
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    worker = createWorker(mongo, channel, finish);
    await worker.start(adaptChannel(channel));
    await waitForSettlement(settled, 30_000);
  } catch (error) {
    failure = error;
  }
  await cleanupChildResources({ mongo, ...(rabbit ? { rabbit } : {}),
    ...(channel ? { channel } : {}), ...(worker ? { worker } : {}) }, failure);
}

await run();
