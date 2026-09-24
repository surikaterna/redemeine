import type { Document, MongoClient } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest, MongoProjectionTransportStore, type AcceptedBaseline, type JoinedApproval,
  type JoinedInventory, type ProjectionTransportDocument } from '../src';
import type { JoinedAuthFixture } from './realJoinedAuth';

export async function verifyMultiInventoryRollback(root: MongoClient, auth: JoinedAuthFixture,
  database: string, sourceId: string, hash: `sha256:${string}`): Promise<readonly string[]> {
  const queueId = `${database}.multi`;
  const names = ['M1', 'M2'] as const;
  const manifest: ProjectionQueueRegistryManifest = { version: 1, queueId, manifestId: hash,
    registryGeneration: 'g1', sourceStartAnchors: { [sourceId]: 1 },
    identity: { version: 1, normalizedDefinitionRegistryDigest: hash, normalizedRuntimeConfigurationDigest: hash,
      executableCodeArtifactDigest: hash }, definitions: names.map((projectionName) => ({
      projectionName, generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true })) };
  const baselines: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId: hash,
    registryGeneration: 'g1', sourceId, lastAcceptedSequence: 0, startAnchor: 1, operator: 'operator',
    acceptedAt: new Date().toISOString(), acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator',
    oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'fixture',
    strategyScope: names.map((projectionName) => ({ projectionName, generation: 'g1',
      strategy: 'own_record' as const, stableSingleTarget: false })) };
  const resources = (client: MongoClient): JoinedInventory[] => names.map((projectionName) => ({ projectionName,
    generation: 'g1', links: client.db(database).collection(`${projectionName}_links`),
    documents: client.db(database).collection(`${projectionName}_documents`) }));
  const draft = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId: hash, registryGeneration: 'g1', approvalNamespace: `${database}.joined_approvals`,
    transportNamespace: `${database}.multi_transport`, approvedBy: 'operator', approvedAt: new Date().toISOString(),
    inventories: names.map((projectionName) => ({ projectionName, generation: 'g1',
      linkNamespace: `${database}.${projectionName}_links`, documentNamespace: `${database}.${projectionName}_documents`,
      expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }], maxLinkRows: 2 })) };
  const approval: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
  const db = root.db(database);
  for (const projectionName of names) {
    await db.collection<Document & { _id: string }>(`${projectionName}_documents`).insertOne({ _id: 'target', state: { count: 0 } });
    await db.collection<Document & { _id: string }>(`${projectionName}_links`).insertOne({ _id: 'Order:one', aggregateType: 'Order',
      aggregateId: 'one', targetDocId: 'target', createdAt: new Date().toISOString() });
  }
  const scoped = (projectionName: string) => [projectionName, 'g1', 'Order', 'one'].join('\u0000');
  const seed = (projectionName: string) => db.collection<Document & { _id: string }>(`${projectionName}_links`).insertOne({ _id: scoped(projectionName),
    aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target', createdAt: new Date().toISOString(), v2Revision: 0 });
  await seed('M1');
  await auth.operatorDb.collection<JoinedApproval>('joined_approvals').insertOne(approval);
  const transportCollection = auth.workerDb.collection<ProjectionTransportDocument>('multi_transport');
  const createTransport = (client: MongoClient): MongoProjectionTransportStore => new MongoProjectionTransportStore({
    mongoClient: client, manifest, joinedInventories: resources(client),
    collection: client.db(database).collection<ProjectionTransportDocument>('multi_transport'),
    joinedApprovals: client.db(database).collection<JoinedApproval>('joined_approvals') });
  const worker = createTransport(auth.worker);
  await worker.initialize();
  await transportCollection.insertOne({ _id: `baseline:${queueId}:${sourceId}`, kind: 'baseline', record: baselines });
  let rejected = false;
  try { await worker.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
  if (!rejected || await transportCollection.countDocuments({ kind: 'joined_adoption' }) !== 0
    || await transportCollection.countDocuments({ kind: 'coverage' }) !== 0
    || await auth.workerDb.collection('multi_dedupe').countDocuments({}) !== 0
    || JSON.stringify(await auth.workerDb.collection<JoinedApproval>('joined_approvals').findOne({ _id: approval._id })) !== JSON.stringify(approval)) {
    throw new Error('Failure after first joined inventory leaked adoption, coverage, progress or approval change.');
  }
  await seed('M2');
  const second = createTransport(auth.secondWorker);
  const conflicting = new MongoProjectionTransportStore({ collection: auth.secondWorkerDb.collection('multi_transport'),
    mongoClient: auth.secondWorker, manifest, joinedApprovals: auth.secondWorkerDb.collection('joined_approvals'),
    joinedInventories: [{ ...resources(auth.secondWorker)[0]!, generation: 'wrong' }, resources(auth.secondWorker)[1]!] });
  const outcomes = await Promise.allSettled([worker.verifyJoinedCutover(queueId, sourceId),
    second.verifyJoinedCutover(queueId, sourceId), conflicting.verifyJoinedCutover(queueId, sourceId)]);
  if (outcomes[0]?.status !== 'fulfilled' || outcomes[1]?.status !== 'fulfilled'
    || outcomes[2]?.status !== 'rejected' || await transportCollection.countDocuments({ kind: 'joined_adoption' }) !== 1) {
    throw new Error('Independent same/different first adopters produced partial or conflicting adoption.');
  }
  return ['multi:second_inventory_failure_snapshot_rolled_back_no_adoption_coverage_progress_or_approval_change',
    'multi:independent_clients_same_inventory_single_adoption_conflicting_inventory_rejected'];
}
