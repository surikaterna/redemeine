import type { Collection, Document, MongoClient } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest, MongoProjectionTransportStore, type AcceptedBaseline, type JoinedApproval,
  type JoinedInventory, type ProjectionTransportDocument } from '../src';
import type { JoinedAuthFixture } from './realJoinedAuth';

const names = ['M1', 'M2'] as const;

function multiConfig(database: string, sourceId: string, hash: `sha256:${string}`) {
  const queueId = `${database}.multi`;
  const manifest: ProjectionQueueRegistryManifest = { version: 1, queueId, manifestId: hash,
    registryGeneration: 'g1', sourceStartAnchors: { [sourceId]: 1 },
    identity: { version: 1, normalizedDefinitionRegistryDigest: hash, normalizedRuntimeConfigurationDigest: hash,
      executableCodeArtifactDigest: hash }, definitions: names.map((projectionName) => ({
      projectionName, generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true })) };
  const baseline: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId: hash,
    registryGeneration: 'g1', sourceId, lastAcceptedSequence: 0, startAnchor: 1, operator: 'operator',
    acceptedAt: new Date().toISOString(), acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator',
    oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'fixture',
    strategyScope: names.map((projectionName) => ({ projectionName, generation: 'g1',
      strategy: 'own_record' as const, stableSingleTarget: false })) };
  const draft = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId: hash, registryGeneration: 'g1', approvalNamespace: `${database}.joined_approvals`,
    transportNamespace: `${database}.multi_transport`, approvedBy: 'operator', approvedAt: new Date().toISOString(),
    inventories: names.map((projectionName) => ({ projectionName, generation: 'g1',
      linkNamespace: `${database}.${projectionName}_links`, documentNamespace: `${database}.${projectionName}_documents`,
      expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }], maxLinkRows: 2 })) };
  const approval: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
  return { queueId, manifest, baseline, approval };
}

async function seedLegacy(root: MongoClient, database: string): Promise<void> {
  const db = root.db(database);
  for (const projectionName of names) {
    await db.collection<Document & { _id: string }>(`${projectionName}_documents`).insertOne({ _id: 'target', state: { count: 0 } });
    await db.collection<Document & { _id: string }>(`${projectionName}_links`).insertOne({ _id: 'Order:one', aggregateType: 'Order',
      aggregateId: 'one', targetDocId: 'target', createdAt: new Date().toISOString() });
  }
}

function seedScoped(root: MongoClient, database: string, projectionName: string): Promise<unknown> {
  const _id = [projectionName, 'g1', 'Order', 'one'].join('\u0000');
  return root.db(database).collection<Document & { _id: string }>(`${projectionName}_links`).insertOne({ _id,
    aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target', createdAt: new Date().toISOString(), v2Revision: 0 });
}

function resources(client: MongoClient, database: string): JoinedInventory[] {
  return names.map((projectionName) => ({ projectionName, generation: 'g1',
    links: client.db(database).collection(`${projectionName}_links`),
    documents: client.db(database).collection(`${projectionName}_documents`) }));
}

function createTransport(client: MongoClient, database: string,
  manifest: ProjectionQueueRegistryManifest): MongoProjectionTransportStore {
  return new MongoProjectionTransportStore({ mongoClient: client, manifest, joinedInventories: resources(client, database),
    collection: client.db(database).collection<ProjectionTransportDocument>('multi_transport'),
    joinedApprovals: client.db(database).collection<JoinedApproval>('joined_approvals') });
}

async function assertRollback(worker: MongoProjectionTransportStore, queueId: string, sourceId: string,
  approval: JoinedApproval, auth: JoinedAuthFixture, transportCollection: Collection<ProjectionTransportDocument>): Promise<void> {
  let rejected = false;
  try { await worker.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
  if (!rejected || await transportCollection.countDocuments({ kind: 'joined_adoption' }) !== 0
    || await transportCollection.countDocuments({ kind: 'coverage' }) !== 0
    || await auth.workerDb.collection('multi_dedupe').countDocuments({}) !== 0
    || JSON.stringify(await auth.workerDb.collection<JoinedApproval>('joined_approvals').findOne({ _id: approval._id })) !== JSON.stringify(approval)) {
    throw new Error('Failure after first joined inventory leaked adoption, coverage, progress or approval change.');
  }
}

async function assertConcurrentAdopters(worker: MongoProjectionTransportStore, auth: JoinedAuthFixture,
  database: string, queueId: string, sourceId: string, manifest: ProjectionQueueRegistryManifest,
  transportCollection: Collection<ProjectionTransportDocument>): Promise<void> {
  const second = createTransport(auth.secondWorker, database, manifest);
  const conflicting = new MongoProjectionTransportStore({ collection: auth.secondWorkerDb.collection('multi_transport'),
    mongoClient: auth.secondWorker, manifest, joinedApprovals: auth.secondWorkerDb.collection('joined_approvals'),
    joinedInventories: [{ ...resources(auth.secondWorker, database)[0]!, generation: 'wrong' },
      resources(auth.secondWorker, database)[1]!] });
  const outcomes = await Promise.allSettled([worker.verifyJoinedCutover(queueId, sourceId),
    second.verifyJoinedCutover(queueId, sourceId), conflicting.verifyJoinedCutover(queueId, sourceId)]);
  if (outcomes[0]?.status !== 'fulfilled' || outcomes[1]?.status !== 'fulfilled'
    || outcomes[2]?.status !== 'rejected' || await transportCollection.countDocuments({ kind: 'joined_adoption' }) !== 1) {
    throw new Error('Independent same/different first adopters produced partial or conflicting adoption.');
  }
}

export async function verifyMultiInventoryRollback(root: MongoClient, auth: JoinedAuthFixture,
  database: string, sourceId: string, hash: `sha256:${string}`): Promise<readonly string[]> {
  const { queueId, manifest, baseline, approval } = multiConfig(database, sourceId, hash);
  await seedLegacy(root, database);
  await seedScoped(root, database, 'M1');
  await auth.operatorDb.collection<JoinedApproval>('joined_approvals').insertOne(approval);
  const transportCollection = auth.workerDb.collection<ProjectionTransportDocument>('multi_transport');
  const worker = createTransport(auth.worker, database, manifest);
  await worker.initialize();
  await transportCollection.insertOne({ _id: `baseline:${queueId}:${sourceId}`, kind: 'baseline', record: baseline });
  await assertRollback(worker, queueId, sourceId, approval, auth, transportCollection);
  await seedScoped(root, database, 'M2');
  await assertConcurrentAdopters(worker, auth, database, queueId, sourceId, manifest, transportCollection);
  return ['multi:second_inventory_failure_snapshot_rolled_back_no_adoption_coverage_progress_or_approval_change',
    'multi:independent_clients_same_inventory_single_adoption_conflicting_inventory_rejected'];
}
