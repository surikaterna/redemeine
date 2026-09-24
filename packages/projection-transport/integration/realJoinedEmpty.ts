import type { Document, MongoClient } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest, MongoProjectionTransportStore, type AcceptedBaseline,
  type JoinedApproval, type ProjectionTransportDocument } from '../src';
import type { JoinedAuthFixture } from './realJoinedAuth';

function emptyConfig(database: string, sourceId: string, hash: `sha256:${string}`) {
  const queueId = `${database}.empty`;
  const manifest: ProjectionQueueRegistryManifest = { version: 1, queueId, manifestId: hash, registryGeneration: 'g1',
    identity: { version: 1, normalizedDefinitionRegistryDigest: hash,
      normalizedRuntimeConfigurationDigest: hash, executableCodeArtifactDigest: hash },
    sourceStartAnchors: { [sourceId]: 1 }, definitions: [{ projectionName: 'Empty', generation: 'g1',
      definitionHash: hash, sourceSelectors: ['Order'], joined: true }] };
  const baseline: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId: hash,
    registryGeneration: 'g1', sourceId, lastAcceptedSequence: 0, startAnchor: 1, operator: 'operator',
    acceptedAt: new Date().toISOString(), acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator',
    oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'fixture',
    strategyScope: [{ projectionName: 'Empty', generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] };
  const inventory = { projectionName: 'Empty', generation: 'g1', linkNamespace: `${database}.empty_links`,
    documentNamespace: `${database}.empty_documents`, expected: [], maxLinkRows: 0,
    knownEmpty: true as const, emptyInventoryReference: 'operator-reviewed Empty join rules and domain inputs: zero subscriptions' };
  const draft = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId: hash, registryGeneration: 'g1', approvalNamespace: `${database}.joined_approvals`,
    transportNamespace: `${database}.empty_transport`, approvedBy: 'operator', approvedAt: new Date().toISOString(),
    inventories: [inventory] };
  const approval: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
  return { queueId, manifest, baseline, approval };
}

export async function verifyAttestedEmptyInventory(root: MongoClient, auth: JoinedAuthFixture, database: string,
  sourceId: string, hash: `sha256:${string}`): Promise<readonly string[]> {
  const { queueId, manifest, baseline, approval } = emptyConfig(database, sourceId, hash);
  const rootDb = root.db(database);
  await rootDb.collection<Document & { _id: string }>('empty_documents').insertOne({ _id: 'existing', state: { count: 1 } });
  if (await rootDb.collection('empty_links').countDocuments({}) !== 0
    || await rootDb.collection('empty_dedupe').countDocuments({}) !== 0
    || await rootDb.collection('empty_transport').countDocuments({}) !== 0) {
    throw new Error('Empty inventory must start with new empty link/progress/transport collections.');
  }
  const collection = auth.workerDb.collection<ProjectionTransportDocument>('empty_transport');
  const transport = new MongoProjectionTransportStore({ collection, mongoClient: auth.worker, manifest,
    joinedInventories: [{ projectionName: 'Empty', generation: 'g1',
      links: auth.workerDb.collection('empty_links'), documents: auth.workerDb.collection('empty_documents') }],
    joinedApprovals: auth.workerDb.collection('joined_approvals') });
  await transport.initialize();
  await collection.insertOne({ _id: `baseline:${queueId}:${sourceId}`, kind: 'baseline', record: baseline });
  const operatorApprovals = auth.operatorDb.collection<JoinedApproval>('joined_approvals');
  const { knownEmpty: _flag, emptyInventoryReference: _reference, ...unreviewed } = approval.inventories[0]!;
  const draft = { ...approval, inventories: [unreviewed] };
  await operatorApprovals.insertOne({ ...draft, digest: approvalDigest(draft) });
  let rejected = false;
  try { await transport.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
  if (!rejected || await collection.countDocuments({ kind: 'joined_adoption' }) !== 0
    || await collection.countDocuments({ kind: 'coverage' }) !== 0
    || await auth.workerDb.collection('empty_dedupe').countDocuments({}) !== 0) {
    throw new Error('Unattested empty inventory was adopted.');
  }
  await rootDb.collection<JoinedApproval>('joined_approvals').deleteOne({ _id: approval._id });
  await operatorApprovals.insertOne(approval);
  await transport.verifyJoinedCutover(queueId, sourceId);
  if (await collection.countDocuments({ kind: 'joined_adoption' }) !== 1
    || await auth.workerDb.collection('empty_links').countDocuments({}) !== 0
    || await auth.workerDb.collection('empty_dedupe').countDocuments({}) !== 0
    || await collection.countDocuments({ kind: 'coverage' }) !== 0) {
    throw new Error('Approved known-empty inventory did not adopt cleanly.');
  }
  return ['empty:unattested_inventory_rejected_no_adoption',
    'empty:attested_code_domain_review_adopts_only_empty_new_links_without_progress_or_coverage'];
}
