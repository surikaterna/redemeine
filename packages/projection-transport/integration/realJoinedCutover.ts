import { MongoClient, type Collection, type Document } from 'mongodb';
import { connect, type ConfirmChannel } from 'amqplib';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import type { ProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { MongoProjectionStore, type ProjectionDocumentRecord, type ProjectionLinkRecord } from '@redemeine/projection-runtime-store-mongodb';
import { approvalDigest, MongoProjectionTransportStore, ProjectionRabbitWorker, type SourceTailPoller, type AcceptedBaseline,
  type JoinedApproval, type JoinedInventory, type ProjectionTransportDocument } from '../src';
import { adaptChannel, tapewormCommit } from './realStackFixtures';
import { createJoinedUsers, verifyOperatorWriteOnce, verifyWorkerApprovalRights } from './realJoinedAuth';
import { verifyMultiInventoryRollback } from './realJoinedMulti';

const uri = process.env.REDEMEINE_MONGO_URI;
if (!uri) throw new Error('REDEMEINE_MONGO_URI required');
const root = new MongoClient(uri);
const name = `zz6h_${Date.now()}`;
const hash = `sha256:${'a'.repeat(64)}` as const;
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cases: string[] = [];
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

async function rejectBeforeAdoption(transport: MongoProjectionTransportStore, queueId: string,
  collection: Collection<ProjectionTransportDocument>, reason: string): Promise<void> {
  let rejected = false;
  try { await transport.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
  assert(rejected, `${reason}: gate admitted unsafe state`);
  assert(await collection.findOne({ _id: `joined_adoption:${queueId}` }) === null, `${reason}: adoption was written`);
  assert(await collection.findOne({ _id: `coverage:${queueId}:${sourceId}` }) === null, `${reason}: coverage was written`);
  cases.push(`${queueId}:${reason}:rejected_no_adoption_or_coverage`);
}

async function rabbitGate(channel: ConfirmChannel, queueId: string, transport: MongoProjectionTransportStore,
  process: ProjectionCommitCoordinator['process'], expectFailure: boolean,
  completed?: () => Promise<boolean>): Promise<void> {
  let bootstrapCount = 0;
  let queueChecks = 0;
  const adapted = adaptChannel(channel);
  const checkQueue = adapted.checkQueue;
  adapted.checkQueue = async (name) => { queueChecks += 1; return checkQueue(name); };
  const tail = { verifyCutover: () => transport.verifyJoinedCutover(queueId, sourceId),
    bootstrap: async () => { bootstrapCount += 1; }, start: () => undefined, stop: async () => undefined,
    isHealthy: () => true, resolveNotification: async (commit: unknown) => ({ status: 'authoritative', commit }) } as unknown as
    SourceTailPoller;
  const coordinator: ProjectionCommitCoordinator = { process, processPolled: process };
  const worker = new ProjectionRabbitWorker({ queue: queueId, deadLetterExchange: `${queueId}.dlx`,
    prefetch: 1, maxMessageBytes: 1_048_576, retryBackoffMs: 1000, coordinator, sourceTail: tail,
    initialize: () => transport.initialize(), scheduleRetry: async () => { throw Error('Unexpected retry'); } });
  if (expectFailure) {
    let failed = false;
    try { await worker.start(adapted); } catch { failed = true; }
    assert(failed && bootstrapCount === 0 && queueChecks === 0, 'Rabbit startup bypassed joined gate');
    return;
  }
  await worker.start(adapted);
  const wire = { ...tapewormCommit(2, [1]), streamId: sourceId };
  assert(channel.sendToQueue(queueId, Buffer.from(JSON.stringify(wire)), { persistent: true, messageId: wire.id }),
    'Rabbit refused joined commit');
  await channel.waitForConfirms();
  let done = false;
  for (let attempt = 0; attempt < 100 && !done; attempt += 1) {
    done = await completed?.() ?? false;
    if (!done) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await worker.stop();
  assert(done, 'Rabbit joined delivery did not update target before timeout');
  assert(bootstrapCount === 1 && queueChecks === 1, 'Rabbit gate did not precede bootstrap and consumption');
}

async function run(): Promise<void> {
  await root.connect();
  const adminDb = root.db(name);
  const auth = await createJoinedUsers(root, uri!, name);
  const client = auth.worker;
  const db = auth.workerDb;
  const rabbitUri = process.env.REDEMEINE_RABBIT_URI;
  const rabbit = rabbitUri ? await connect(rabbitUri) : null;
  const channel = rabbit ? await rabbit.createConfirmChannel() : null;
  const declaredQueues: string[] = [];
  const mongoVersion = (await root.db('admin').admin().command({ buildInfo: 1 })).version;
  const rabbitVersion = rabbit?.connection.serverProperties.version;
  try {
    for (const projectionName of ['A', 'B']) {
      const queueId = `${name}.${projectionName}`;
      const manifest: ProjectionQueueRegistryManifest = { version: 1, queueId, manifestId: hash, registryGeneration: 'g1',
        identity: { version: 1, normalizedDefinitionRegistryDigest: hash,
          normalizedRuntimeConfigurationDigest: hash, executableCodeArtifactDigest: hash },
        definitions: [{ projectionName, generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true }],
        sourceStartAnchors: { [sourceId]: 1 } };
      const links = adminDb.collection<Document & { _id: string }>(`${projectionName}_links`);
      const documents = adminDb.collection<Document & { _id: string }>(`${projectionName}_documents`);
      await documents.insertOne({ _id: 'target', state: { count: 0 } });
      const now = new Date().toISOString();
      const legacy = { _id: 'Order:one', aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target', createdAt: now };
      await links.insertOne(legacy);
      const item: JoinedInventory = { projectionName, generation: 'g1',
        links: db.collection(`${projectionName}_links`), documents: db.collection(`${projectionName}_documents`) };
      const draft = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
        manifestId: hash, registryGeneration: 'g1', approvalNamespace: `${name}.joined_approvals`,
        transportNamespace: `${name}.${projectionName}_transport`,
        approvedBy: 'operator', approvedAt: new Date().toISOString(), inventories: [{ projectionName, generation: 'g1',
          linkNamespace: `${name}.${projectionName}_links`, documentNamespace: `${name}.${projectionName}_documents`,
          expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }], maxLinkRows: 3 }] };
      const approval: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
      const baseline: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId: hash,
        registryGeneration: 'g1', sourceId, lastAcceptedSequence: 0, startAnchor: 1, operator: 'operator',
        acceptedAt: new Date().toISOString(), acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator',
        oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'fixture',
        strategyScope: [{ projectionName, generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] };
      const transportCollection = db.collection<ProjectionTransportDocument>(`${projectionName}_transport`);
      const approvals = auth.operatorDb.collection<JoinedApproval>('joined_approvals');
      const workerApprovals = db.collection<JoinedApproval>('joined_approvals');
      const transport = new MongoProjectionTransportStore({ collection: transportCollection, mongoClient: client,
        manifest, joinedInventories: [item], joinedApprovals: workerApprovals });
      if (channel) {
        await channel.assertExchange(`${queueId}.dlx`, 'direct', { durable: true, arguments: {} });
        await channel.assertQueue(queueId, { durable: true, deadLetterExchange: `${queueId}.dlx` });
        declaredQueues.push(queueId);
      }
      await transport.initialize();
      await transportCollection.insertOne({ _id: `baseline:${queueId}:${sourceId}`, kind: 'baseline', record: baseline });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'missing approval');
      await approvals.insertOne(approval);
      await verifyOperatorWriteOnce(approvals, approval);
      await verifyWorkerApprovalRights(workerApprovals, approval._id);
      cases.push(`${projectionName}:operator_insert_only_and_worker_approval_writes_denied_before_activation`);
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'omitted scoped seed');
      if (channel) await rabbitGate(channel, queueId, transport, async () => {
        throw Error('Rejected cutover dispatched a joined event');
      }, true);
      assert(await transportCollection.findOne({ _id: `coverage:${queueId}:${sourceId}` }) === null
        && await db.collection(`${projectionName}_dedupe`).countDocuments({}) === 0,
      'Rabbit rejection wrote coverage or own-record progress');
      cases.push(`${projectionName}:rabbit_precheck_rejected_before_bootstrap_consume_coverage_own_progress`);
      assert(await db.collection(`${projectionName}_dedupe`).countDocuments({}) === 0,
        'Omission wrote own-record progress');
      const scopedId = [projectionName, 'g1', 'Order', 'one'].join('\u0000');
      await links.insertOne({ _id: scopedId, aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target',
        createdAt: new Date().toISOString(), v2Revision: 0 });
      await links.deleteOne({ _id: 'Order:one' });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'missing legacy');
      await links.insertOne(legacy);
      await links.updateOne({ _id: scopedId }, { $set: { aggregateType: 'Wrong' } });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'wrong scoped type');
      await links.updateOne({ _id: scopedId }, { $set: { aggregateType: 'Order' } });
      await links.insertOne({ _id: 'other\u0000g2\u0000Order\u0000one', targetDocId: 'target' });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'unknown scoped');
      await links.deleteOne({ _id: 'other\u0000g2\u0000Order\u0000one' });
      await links.insertOne({ _id: 'Order:extra', targetDocId: 'target' });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'unknown legacy');
      await links.deleteOne({ _id: 'Order:extra' });
      await links.updateOne({ _id: scopedId }, { $set: { targetDocId: null } });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'tombstoned link');
      await links.updateOne({ _id: scopedId }, { $set: { targetDocId: 'target' } });
      await links.updateOne({ _id: 'Order:one' }, { $set: { aggregateId: 'wrong' } });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'malformed legacy');
      await links.updateOne({ _id: 'Order:one' }, { $set: { aggregateId: 'one' } });
      await documents.updateOne({ _id: 'target' }, { $set: { tombstone: true } });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'tombstone target');
      await documents.updateOne({ _id: 'target' }, { $unset: { tombstone: '' } });
      await documents.deleteOne({ _id: 'target' });
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'missing target');
      await documents.insertOne({ _id: 'target', state: { count: 0 } });
      await links.insertMany([{ _id: 'extra1', targetDocId: 'target' }, { _id: 'extra2', targetDocId: 'target' }]);
      await rejectBeforeAdoption(transport, queueId, transportCollection, 'overflow');
      await links.deleteMany({ _id: { $in: ['extra1', 'extra2'] } });
      const wrongHandle = new MongoProjectionTransportStore({ collection: transportCollection, mongoClient: client,
        manifest, joinedInventories: [{ ...item, links: db.collection(`${projectionName}_wrong_links`) }],
        joinedApprovals: workerApprovals });
      await rejectBeforeAdoption(wrongHandle, queueId, transportCollection, 'wrong physical link handle');
      const second = new MongoProjectionTransportStore({
        collection: auth.secondWorkerDb.collection<ProjectionTransportDocument>(`${projectionName}_transport`),
        mongoClient: auth.secondWorker, manifest,
        joinedInventories: [{ ...item, links: auth.secondWorkerDb.collection(`${projectionName}_links`),
          documents: auth.secondWorkerDb.collection(`${projectionName}_documents`) }],
        joinedApprovals: auth.secondWorkerDb.collection<JoinedApproval>('joined_approvals') });
      const arrivals = await Promise.allSettled([transport.verifyJoinedCutover(queueId, sourceId),
        second.verifyJoinedCutover(queueId, sourceId), wrongHandle.verifyJoinedCutover(queueId, sourceId)]);
      assert(arrivals[0]?.status === 'fulfilled' && arrivals[1]?.status === 'fulfilled'
        && arrivals[2]?.status === 'rejected'
        && await transportCollection.countDocuments({ _id: `joined_adoption:${queueId}` }) === 1,
      'Independent first adopters did not converge on the single approved inventory');
      cases.push(`${projectionName}:independent_clients_same_approval_one_adoption_conflicting_handle_rejected`);
      const store = new MongoProjectionStore<{ count: number }>({
        collection: db.collection<ProjectionDocumentRecord<{ count: number }>>(`${projectionName}_documents`),
        linkCollection: db.collection<ProjectionLinkRecord>(`${projectionName}_links`),
        dedupeCollection: db.collection(`${projectionName}_dedupe`), mongoClient: client });
      await store.initializeProjectionSourceCommitStore();
      const snapshot = await store.loadProjectionSourceCommitSnapshot({ projectionName, projectionGeneration: 'g1',
        targetDocumentIds: ['target'], links: [{ aggregateType: 'Order', aggregateId: 'one' }],
        progressStrategy: 'own_record', sourceId });
      assert(snapshot.links[0]?.targetDocumentId === 'target' && snapshot.links[0]?.revision === 0,
        'Seeded link was not read by sourceCommitV2');
      const target = snapshot.targets[0];
      assert(target?.state?.count === 0, 'Existing target missing from snapshot');
      const result = await store.commitProjectionSourceCommit({ version: 1, mode: 'atomic-all', projectionName,
        projectionGeneration: 'g1', commit: { streamId: sourceId, commitSequence: 1,
          commitId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', events: [{ eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            eventIndex: 0, streamVersion: 1, aggregateType: 'Order', aggregateId: 'one', type: 'Changed', payload: {},
            timestamp: new Date().toISOString() }] },
        finalDocuments: [{ targetDocumentId: 'target', expectedRevision: target.revision,
          finalDocument: { count: 1 }, ...(target.legacyOriginal ? { legacyOriginal: target.legacyOriginal } : {}) }],
        stagedLinks: [], progress: { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 1 } } });
      assert(result.status === 'committed' && (await documents.findOne({ _id: 'target' }))?.state?.count === 1,
        'Post-B joined update did not reach existing target');
      cases.push(`${projectionName}:post_B_joined_target_updated_by_worker_store`);
      if (channel) {
        await rabbitGate(channel, queueId, transport, async (commit) => {
          const current = await store.loadProjectionSourceCommitSnapshot({ projectionName, projectionGeneration: 'g1',
            targetDocumentIds: ['target'], links: [{ aggregateType: 'Order', aggregateId: 'one' }],
            progressStrategy: 'own_record', sourceId });
          assert(current.links[0]?.targetDocumentId === 'target', 'Rabbit joined event lost scoped target');
          const updated = await store.commitProjectionSourceCommit({ version: 1, mode: 'atomic-all', projectionName,
            projectionGeneration: 'g1', commit, finalDocuments: [{ targetDocumentId: 'target',
              expectedRevision: current.targets[0]!.revision, finalDocument: { count: 2 } }], stagedLinks: [],
            progress: { strategy: 'own_record', source: { sourceId, expectedSequence: 1, finalSequence: 2 } } });
          assert(updated.status === 'committed', 'Rabbit joined store commit failed');
          return { status: 'completed', processedSequences: [2], definitions: [] };
        }, false, async () => (await documents.findOne({ _id: 'target' }))?.state?.count === 2);
        assert((await documents.findOne({ _id: 'target' }))?.state?.count === 2, 'Rabbit joined event missed target');
        cases.push(`${projectionName}:real_broker_delivery_fake_coordinator_poller_target_updated`);
      }
      await links.updateOne({ _id: scopedId }, { $set: { targetDocId: null, v2Revision: 1 } });
      await transport.verifyJoinedCutover(queueId, sourceId);
      await links.insertOne({ _id: [projectionName, 'g1', 'Order', 'new'].join('\u0000'),
        aggregateType: 'Order', aggregateId: 'new', targetDocId: 'target', createdAt: new Date().toISOString(), v2Revision: 0 });
      await transport.verifyJoinedCutover(queueId, sourceId);
      await verifyWorkerApprovalRights(workerApprovals, approval._id);
      cases.push(`${projectionName}:worker_approval_writes_denied_after_activation_unsubscribe_restart`);
      const adminApprovals = adminDb.collection<JoinedApproval>('joined_approvals');
      await adminApprovals.updateOne({ _id: approval._id }, { $set: { digest: hash } });
      let rejected = false;
      try { await transport.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
      assert(rejected, 'Changed approval digest admitted on restart');
      await adminApprovals.updateOne({ _id: approval._id }, { $set: { digest: approval.digest } });
      const changed = new MongoProjectionTransportStore({ collection: transportCollection, mongoClient: client,
        manifest, joinedInventories: [{ ...item, links: db.collection(`${projectionName}_wrong_links`) }],
        joinedApprovals: approvals });
      rejected = false;
      try { await changed.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
      assert(rejected, 'Changed inventory admitted on restart');
      cases.push(`${projectionName}:changed_approval_digest_and_physical_handle_rejected_on_restart`);
    }
    cases.push(...await verifyMultiInventoryRollback(root, auth, name, sourceId, hash));
  } finally {
    if (channel) {
      for (const queue of declaredQueues) {
        await channel.deleteQueue(queue);
        await channel.deleteExchange(`${queue}.dlx`);
      }
      await channel.close();
    }
    await rabbit?.close();
    await Promise.all([auth.operator.close(), auth.worker.close(), auth.secondWorker.close()]);
    await adminDb.dropDatabase();
    const users = await adminDb.command({ usersInfo: 1 });
    assert(Array.isArray(users.users) && users.users.length === 0, 'Fixture Mongo users were not cleaned up');
    assert(!(await root.db('admin').admin().listDatabases()).databases.some((entry) => entry.name === name),
      'Fixture Mongo database was not cleaned up');
    await root.close();
  }
  console.log(JSON.stringify({ gitSha: process.env.REDEMEINE_GIT_SHA, database: name, scope:
    'focused_broker_wiring_with_fake_coordinator_and_poller_not_full_stack_qualification',
  mongoImage: process.env.REDEMEINE_MONGO_DIGEST, rabbitImage: process.env.REDEMEINE_RABBIT_DIGEST,
  versions: { mongo: mongoVersion, rabbit: rabbitVersion }, queues: declaredQueues,
  auth: 'operator_insert_only_worker_approval_read_only_collection_scoped_roles',
  cases, mongoUsersAndDatabaseCleaned: true, queuesAndExchangesDeleted: declaredQueues.length === 2 }));
}

await run();
