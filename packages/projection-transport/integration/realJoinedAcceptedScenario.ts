import type { ConfirmChannel } from 'amqplib';
import type { Db, Document, MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import type EventStore from 'tapeworm';
import { MongoProjectionStore, type ProjectionDocumentRecord, type ProjectionLinkRecord } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { MongoProjectionTransportStore, ProjectionRabbitWorker, SourceTailPoller, type AcceptedBaseline,
  type JoinedApproval, type ProjectionTransportDocument, type TapewormMongoRangeReader } from '../src';
import { adaptChannel, SOURCE_ID, tapewormCommit, type StackEvent } from './realStackFixtures';
import { JOINED_AGGREGATE_ID, JOINED_AGGREGATE_TYPE, JOINED_BASELINE, JOINED_GENERATION, JOINED_NAME,
  JOINED_SEQUENCE, JOINED_TARGET, joinedApproval, joinedCollections, joinedDefinition, joinedManifest,
  registerJoinedQueue, type JoinedState } from './realJoinedAcceptedDefinition';

export interface JoinedStackContext {
  readonly mongo: MongoClient;
  readonly channel: ConfirmChannel;
  readonly db: Db;
  readonly partition: Awaited<ReturnType<InstanceType<typeof EventStore>['openPartition']>>;
  readonly reader: TapewormMongoRangeReader;
  readonly queues: string[];
}

export interface JoinedScenarioEvidence {
  readonly name: 'B3-joined-manual-seed';
  readonly queueId: string;
  readonly baseline: 3;
  readonly rejectedBeforeQueueCheckBootstrapConsume: true;
  readonly noCoverageOrOwnRecordOnRejection: true;
  readonly newLinkAndProgressEmptyBeforeSeed: true;
  readonly scopedRowsAfterSeed: 1;
  readonly manuallySeededLink: string;
  readonly targetDocumentId: string;
  readonly targetCount: number;
  readonly v2Revision: number;
  readonly ownRecordSequence: number;
  readonly coveredSequence: number;
  readonly acknowledgements: number;
  readonly restartRedeliveryDeduplicated: true;
}

function assert(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Joined projection bounded observation timed out.');
}

function acceptedBaseline(queue: string, manifestId: string): AcceptedBaseline {
  return { version: 2, kind: 'existing', queueBindingId: queue, manifestId: manifestId as `sha256:${string}`,
    registryGeneration: JOINED_GENERATION, sourceId: SOURCE_ID,
    lastAcceptedSequence: JOINED_BASELINE, startAnchor: JOINED_SEQUENCE,
    operator: 'accepted-stack-operator', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'accepted-stack-operator',
    oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'indexed-source-polling',
    strategyScope: [{ projectionName: JOINED_NAME, generation: JOINED_GENERATION,
      strategy: 'own_record', stableSingleTarget: false }] };
}

function instrumentChannel(channel: ConfirmChannel) {
  const adapter = adaptChannel(channel);
  let checkCount = 0;
  let consumeCount = 0;
  const checkQueue = adapter.checkQueue.bind(adapter);
  const consume = adapter.consume.bind(adapter);
  adapter.checkQueue = async (name) => { checkCount += 1; return checkQueue(name); };
  adapter.consume = async (name, handler, options) => { consumeCount += 1; return consume(name, handler, options); };
  return { adapter, checkCount: () => checkCount, consumeCount: () => consumeCount };
}

function createRuntime(ctx: JoinedStackContext, queue: string) {
  const manifest = joinedManifest(queue);
  const transport = new MongoProjectionTransportStore({
    collection: ctx.db.collection<ProjectionTransportDocument>(joinedCollections.transport), mongoClient: ctx.mongo,
    manifest, cutoverReadiness: { reader: ctx.reader },
    joinedInventories: [{ projectionName: JOINED_NAME, generation: JOINED_GENERATION,
      links: ctx.db.collection<Document & { _id: string }>(joinedCollections.links),
      documents: ctx.db.collection<Document & { _id: string }>(joinedCollections.documents) }],
    joinedApprovals: ctx.db.collection<JoinedApproval>(joinedCollections.approvals) });
  const store = new MongoProjectionStore<JoinedState>({
    collection: ctx.db.collection<ProjectionDocumentRecord<JoinedState>>(joinedCollections.documents),
    linkCollection: ctx.db.collection<ProjectionLinkRecord>(joinedCollections.links),
    dedupeCollection: ctx.db.collection(joinedCollections.dedupe),
    mongoClient: ctx.mongo });
  const coordinator = createProjectionCommitCoordinator({ queueBindingId: queue, manifest,
    definitions: [joinedDefinition()], store, sourceOrder: transport, rangeReader: ctx.reader,
    maxCommits: 2, maxBytes: 1_048_576, maxGapPages: 5 });
  const errors: string[] = [];
  const tail = new SourceTailPoller({ queueId: queue, sourceIds: [SOURCE_ID], transport, reader: ctx.reader,
    coordinator, maxCommits: 1, maxBytes: 1_048_576, maxPages: 1, intervalMs: 50,
    onFailure: (error) => errors.push(error.message) });
  let bootstraps = 0;
  const bootstrap = tail.bootstrap.bind(tail);
  tail.bootstrap = async () => { bootstraps += 1; await bootstrap(); };
  const settlements: string[] = [];
  const worker = new ProjectionRabbitWorker({ queue, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed',
    prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 1_000, coordinator, sourceTail: tail,
    initialize: () => transport.initialize(),
    scheduleRetry: async () => { throw new Error('Unexpected joined retry publication.'); },
    observeSettlement: ({ kind }) => { settlements.push(kind); } });
  return { worker, tail, transport, settlements, errors, bootstraps: () => bootstraps };
}

async function prepare(ctx: JoinedStackContext, queue: string): Promise<void> {
  await ctx.channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true, arguments: {} });
  await ctx.channel.assertQueue(queue, { durable: true, deadLetterExchange: `${queue}.dlx`, deadLetterRoutingKey: 'failed' });
  registerJoinedQueue(ctx.queues, queue);
  const documents = ctx.db.collection<Document & { _id: string }>(joinedCollections.documents);
  await documents.insertOne({ _id: JOINED_TARGET, state: { count: 10, seen: [] }, updatedAt: new Date().toISOString() });
  assert(await ctx.db.collection(joinedCollections.links).countDocuments({}) === 0
    && await ctx.db.collection(joinedCollections.dedupe).countDocuments({}) === 0
    && await ctx.db.collection(joinedCollections.transport).countDocuments({}) === 0,
  'New joined link/progress/transport collections must start empty.');
  const manifest = joinedManifest(queue);
  await ctx.db.collection<JoinedApproval>(joinedCollections.approvals).insertOne(joinedApproval(manifest, ctx.db.databaseName));
  const runtime = createRuntime(ctx, queue);
  await runtime.transport.installAcceptedBaseline(acceptedBaseline(queue, manifest.manifestId));
}

async function assertRejectedBeforeDispatch(ctx: JoinedStackContext, queue: string): Promise<void> {
  const runtime = createRuntime(ctx, queue);
  const observed = instrumentChannel(ctx.channel);
  let rejected = false;
  try { await runtime.worker.start(observed.adapter); } catch { rejected = true; }
  assert(rejected && observed.checkCount() === 0 && observed.consumeCount() === 0 && runtime.bootstraps() === 0,
    'Missing scoped link was not rejected before queue check/bootstrap/consume.');
  const coverage = await runtime.transport.loadCoveredThrough(queue, SOURCE_ID);
  const ownCount = await ctx.db.collection(joinedCollections.dedupe).countDocuments({});
  assert(coverage === null && ownCount === 0, 'Rejected joined cutover advanced coverage or own-record progress.');
  const target = await ctx.db.collection<Document & { _id: string }>(joinedCollections.documents).findOne({ _id: JOINED_TARGET });
  assert(target?.v2Revision === undefined && target?.sourceProgress === undefined,
    'Rejected joined cutover touched legacy target.');
}

async function seedScoped(ctx: JoinedStackContext): Promise<string> {
  const _id = [JOINED_NAME, JOINED_GENERATION, JOINED_AGGREGATE_TYPE, JOINED_AGGREGATE_ID].join('\u0000');
  const row = { _id, aggregateType: JOINED_AGGREGATE_TYPE, aggregateId: JOINED_AGGREGATE_ID,
    targetDocId: JOINED_TARGET, createdAt: new Date().toISOString(), v2Revision: 0 };
  const links = ctx.db.collection<Document & { _id: string }>(joinedCollections.links);
  await links.updateOne({ _id }, { $setOnInsert: row }, { upsert: true });
  const actual = await links.findOne({ _id });
  assert(actual && Object.keys(actual).length === Object.keys(row).length
    && Object.entries(row).every(([key, value]) => actual[key] === value)
    && await links.countDocuments({}) === 1,
  'Manual scoped link seed conflicted with persisted row.');
  return _id;
}

function joinedCommit(): ICommit<StackEvent> {
  const commit = tapewormCommit(JOINED_SEQUENCE, [3]);
  return { ...commit, events: commit.events.map((event) => ({ ...event,
    aggregateType: JOINED_AGGREGATE_TYPE, aggregateId: JOINED_AGGREGATE_ID })) };
}

async function redeliver(ctx: JoinedStackContext, queue: string, commit: ICommit<StackEvent>): Promise<void> {
  assert(ctx.channel.sendToQueue(queue, Buffer.from(JSON.stringify(commit)), { persistent: true, messageId: commit.id }),
    'Rabbit refused joined post-B notification.');
  await ctx.channel.waitForConfirms();
}

async function assertApplied(ctx: JoinedStackContext, runtime: ReturnType<typeof createRuntime>, queue: string): Promise<void> {
  await waitFor(async () => {
    const target = await ctx.db.collection<Document & { _id: string }>(joinedCollections.documents).findOne({ _id: JOINED_TARGET });
    return target?.state?.count === 13 && await runtime.transport.loadCoveredThrough(queue, SOURCE_ID) === JOINED_SEQUENCE;
  });
  const target = await ctx.db.collection<Document & { _id: string }>(joinedCollections.documents).findOne({ _id: JOINED_TARGET });
  const ownId = [JOINED_NAME, JOINED_GENERATION, SOURCE_ID].join('\u0000');
  const own = await ctx.db.collection<Document & { _id: string }>(joinedCollections.dedupe).findOne({ _id: ownId });
  assert(target?.v2Revision === 1 && JSON.stringify(target.state?.seen) === '[3]'
    && target.sourceProgress === undefined && own?.commitSequence === JOINED_SEQUENCE,
  'Joined event did not update the existing legacy target and durable own-record progress exactly once.');
}

async function runPositive(ctx: JoinedStackContext, queue: string, commit: ICommit<StackEvent>): Promise<number> {
  const runtime = createRuntime(ctx, queue);
  try {
    await runtime.worker.start(adaptChannel(ctx.channel));
    assert(await runtime.transport.loadCoveredThrough(queue, SOURCE_ID) === null,
      'B=3 source tail advanced coverage before the post-B joined event.');
    await ctx.partition.append([commit]);
    await assertApplied(ctx, runtime, queue);
    await redeliver(ctx, queue, commit);
    await waitFor(async () => runtime.settlements.filter((kind) => kind === 'ack').length === 1);
    await assertApplied(ctx, runtime, queue);
    assert(runtime.errors.length === 0, 'Joined indexed source tail reported failure.');
    return runtime.settlements.filter((kind) => kind === 'ack').length;
  } finally {
    await runtime.worker.stop();
  }
}

async function runRestart(ctx: JoinedStackContext, queue: string, commit: ICommit<StackEvent>): Promise<number> {
  const runtime = createRuntime(ctx, queue);
  try {
    await runtime.worker.start(adaptChannel(ctx.channel));
    await redeliver(ctx, queue, commit);
    await waitFor(async () => runtime.settlements.filter((kind) => kind === 'ack').length === 1);
    await assertApplied(ctx, runtime, queue);
    assert(runtime.errors.length === 0, 'Restarted joined indexed source tail reported failure.');
    return runtime.settlements.filter((kind) => kind === 'ack').length;
  } finally {
    await runtime.worker.stop();
  }
}

export async function runJoinedAcceptedScenario(ctx: JoinedStackContext): Promise<JoinedScenarioEvidence> {
  const queue = `${ctx.db.databaseName}.joined_manual`;
  assert(await ctx.reader.probeSource(SOURCE_ID, JOINED_BASELINE) === JOINED_BASELINE,
    'Accepted B=3 is not present in the indexed source before joined cutover.');
  await prepare(ctx, queue);
  await assertRejectedBeforeDispatch(ctx, queue);
  const scopedId = await seedScoped(ctx);
  const commit = joinedCommit();
  const firstAck = await runPositive(ctx, queue, commit);
  const restartAck = await runRestart(ctx, queue, commit);
  const target = await ctx.db.collection<Document & { _id: string }>(joinedCollections.documents).findOne({ _id: JOINED_TARGET });
  assert(target?.state?.count === 13 && target.v2Revision === 1, 'Joined target changed on restart/redelivery.');
  return { name: 'B3-joined-manual-seed', queueId: queue, baseline: JOINED_BASELINE,
    rejectedBeforeQueueCheckBootstrapConsume: true, noCoverageOrOwnRecordOnRejection: true,
    newLinkAndProgressEmptyBeforeSeed: true, scopedRowsAfterSeed: 1,
    manuallySeededLink: scopedId, targetDocumentId: JOINED_TARGET,
    targetCount: target.state.count, v2Revision: target.v2Revision,
    ownRecordSequence: JOINED_SEQUENCE, coveredSequence: JOINED_SEQUENCE, acknowledgements: firstAck + restartAck,
    restartRedeliveryDeduplicated: true };
}
