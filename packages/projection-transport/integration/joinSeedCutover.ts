import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { Db, Document, MongoClient } from 'mongodb';
import {
  approvalDigest, joinedMembershipSeedRow, MongoProjectionTransportStore, type AcceptedBaseline, type ApprovedJoinedSetInventory,
  type JoinedApproval, type ProjectionTransportDocument, type TapewormMongoRangeReader
} from '../src';
import { fixtureRuntime, generation, path, read, type Backend, viewFixture } from './joinSeedFixture';
import { complete, order } from './joinSeedScenarios';

export async function adoptedForwardOnly(db: Db, client: MongoClient, backend: Backend) {
  const source = randomUUID();
  let reads = 0;
  const { options } = fixtureRuntime(backend, viewFixture(async () => { reads += 1; return null; }));
  const manifest = { ...options.manifest, sourceStartAnchors: { [source]: 1 } };
  const { manifestId, queueId, registryGeneration } = manifest;
  const scope = { projectionName: 'boards', generation };
  const collection = db.collection<ProjectionTransportDocument>('cutover');
  const approvals = db.collection<JoinedApproval>('approvals');
  const links = db.collection<Document & { _id: string }>('memberships');
  const documents = db.collection<Document & { _id: string }>('boards');
  const reader: TapewormMongoRangeReader = { ...options.rangeReader, initialize: async () => {}, probeSource: async () => 1,
    getIndexName: () => 'synthetic-source-index',
    getQueryObservation: () => ({ cursorMethod: 'find.sort.hint.limit.batchSize.asyncIterator', maxReturnedBytes: 0,
      maxReturnedDocuments: 0, sourceProbeMethod: 'findOne.hint + find.sort(-1).hint.limit(1)' }) };
  const transport = new MongoProjectionTransportStore({ collection, joinedApprovals: approvals, mongoClient: client,
    manifest, joinedInventories: [{ ...scope, links, documents }], cutoverReadiness: { reader } });
  const accepted: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId, registryGeneration,
    sourceId: source, startAnchor: 1, lastAcceptedSequence: 0, operator: 'operator', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator', oldWriterStoppedAt: new Date().toISOString(),
    queueTailReadinessReference: 'synthetic fixture',
    strategyScope: [{ ...scope, strategy: 'own_record', stableSingleTarget: false }] };
  await transport.installAcceptedBaseline(accepted);
  const expected = { ...path, targetDocumentIds: ['A'] };
  const inventory: ApprovedJoinedSetInventory = { ...scope, format: 'set-v1', linkNamespace: links.namespace,
    documentNamespace: documents.namespace, expectedSets: [expected], maxLinkRows: 1, maxEdges: 1, maxTargetBytes: 2048 };
  const approval = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId, registryGeneration, approvalNamespace: approvals.namespace, transportNamespace: collection.namespace,
    approvedBy: 'operator', approvedAt: new Date().toISOString(), inventories: [inventory] };
  await approvals.insertOne({ ...approval, digest: approvalDigest(approval) });
  await links.insertOne(joinedMembershipSeedRow(scope, expected));
  await documents.insertOne({ _id: 'A', state: { total: 40, effects: [] }, updatedAt: new Date().toISOString() });
  await transport.verifyJoinedCutover(queueId, source);
  await complete(createProjectionCommitCoordinator({ ...options, manifest, store: backend.store(), sourceOrder: transport }),
    order(source, 1, [['delta', { amount: 3 }]]));
  assert.equal(await transport.loadCoveredThrough(queueId, source), 1);
  const actual = await read(backend, source, 'A');
  assert.deepEqual(actual.states[0], { total: 43, effects: ['delta:unseeded'] });
  assert.deepEqual(actual.row.targetDocumentIds, ['A']);
  assert.equal(actual.row.seeds, undefined);
  assert.equal(reads, 0);
}
