import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Db, Document, MongoClient } from 'mongodb';
import {
  MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord
} from '@redemeine/projection-runtime-store-mongodb';
import {
  approvalDigest, joinedMembershipSeedRow, MongoProjectionTransportStore, type AcceptedBaseline, type ApprovedJoinedSetInventory,
  type JoinedApproval, type ProjectionTransportDocument, type TapewormMongoRangeReader
} from '../src';
import { coordinator, fixtureOptions, manifest, orderId, path, snapshot, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

export async function seedCutover(db: Db, client: MongoClient, source: string) {
  const registry = manifest('forward-cutover', { [source]: 1 });
  const { queueId, manifestId, registryGeneration } = registry;
  const collection = db.collection<ProjectionTransportDocument>('transport');
  const joinedApprovals = db.collection<JoinedApproval>('approvals');
  const members = db.collection<Document & { _id: string }>('memberships');
  const docs = db.collection<Document & { _id: string }>('views');
  const scope = { projectionName: 'boards', generation: 'set-generation' };
  const store = new MongoProjectionStore<State>({
    collection: db.collection<ProjectionDocumentRecord<State>>(docs.collectionName),
    joinMembershipCollection: db.collection<ProjectionJoinMembershipRecord>(members.collectionName),
    changeCollection: db.collection<MongoProjectionChangesRecord>('changes'),
    linkCollection: db.collection('set-generation-unused-scalar'),
    dedupeCollection: db.collection('set-progress'), mongoClient: client
  });
  const fixture = fixtureOptions(store);
  const reader: TapewormMongoRangeReader = { ...fixture.rangeReader, initialize: async () => {}, probeSource: async () => 1,
    getIndexName: () => 'synthetic-source-index',
    getQueryObservation: () => ({ cursorMethod: 'find.sort.hint.limit.batchSize.asyncIterator', maxReturnedBytes: 0,
      maxReturnedDocuments: 0, sourceProbeMethod: 'findOne.hint + find.sort(-1).hint.limit(1)' }) };
  const makeTransport = (links = members) => new MongoProjectionTransportStore({ collection, joinedApprovals, mongoClient: client,
    manifest: registry, joinedInventories: [{ ...scope, links, documents: docs }], cutoverReadiness: { reader } });
  const transport = makeTransport();
  const baseline: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId, registryGeneration,
    sourceId: source, startAnchor: 1, lastAcceptedSequence: 0, operator: 'operator', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator', oldWriterStoppedAt: new Date().toISOString(),
    queueTailReadinessReference: 'synthetic fixture',
    strategyScope: [{ ...scope, strategy: 'own_record', stableSingleTarget: false }] };
  await transport.installAcceptedBaseline(baseline);
  return { scope, registry, collection, joinedApprovals, members, docs, store, fixture, makeTransport, transport };
}

export async function runJoinMembershipCutover(db: Db, client: MongoClient): Promise<void> {
  const source = randomUUID();
  const { scope, registry, collection, joinedApprovals, members, docs, store, fixture, makeTransport, transport } =
    await seedCutover(db, client, source);
  const { queueId, manifestId, registryGeneration } = registry;
  const adopted = `joined_adoption:${queueId}`;
  const expectedSets = [{ ...path, targetDocumentIds: ['A', 'B'] }, { ...path, aggregateId: 'tombstone', targetDocumentIds: [] }];
  const inventory: ApprovedJoinedSetInventory = { ...scope, format: 'set-v1', linkNamespace: members.namespace,
    documentNamespace: docs.namespace, expectedSets, maxLinkRows: 2, maxEdges: 2, maxTargetBytes: 2048 };
  const approval = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId,
    manifestId, registryGeneration, approvalNamespace: joinedApprovals.namespace, transportNamespace: collection.namespace,
    approvedBy: 'operator', approvedAt: new Date().toISOString(), inventories: [inventory] };
  const verify = () => transport.verifyJoinedCutover(queueId, source);
  await assert.rejects(verify, /approval/);
  await joinedApprovals.insertOne({ ...approval, digest: approvalDigest(approval) });
  const seeds = expectedSets.map((set) => joinedMembershipSeedRow(scope, set));
  const first = seeds[0]!;
  await members.insertOne({ _id: first._id, ...path, targetDocId: 'A', v2Revision: 0 });
  await assert.rejects(verify, /differs/);
  await members.replaceOne({ _id: first._id }, first);
  await assert.rejects(verify, /missing approved/i);
  await members.insertOne(seeds[1]!);
  await docs.insertOne({ _id: 'A', state: { id: 'A', visits: [] }, updatedAt: new Date().toISOString() });
  await assert.rejects(verify, /missing or tombstoned/);
  assert.equal(await collection.findOne({ _id: adopted }), null);
  await docs.insertOne({ _id: 'B', state: { id: 'B', visits: [] }, updatedAt: new Date().toISOString() });
  await verify();
  const restarted = makeTransport();
  const runtime = coordinator({ ...fixture, queueBindingId: queueId, manifest: registry, sourceOrder: restarted });
  await completed(runtime, turn(source, 1, orderId, [['ordinary']]));
  assert.deepEqual((await snapshot(store, source, ['A', 'B'])).targets.map(({ state }) => state?.visits), [['ordinary'], ['ordinary']]);
  assert.equal((await db.collection('set-progress').findOne({ sourceId: source }))?.acceptedBaselineSequence, 0);
  await makeTransport().verifyJoinedCutover(queueId, source);
  assert.equal(await restarted.loadCoveredThrough(queueId, source), 1);
  assert.equal((await members.findOne({ _id: first._id }))?.revision, 1);
}
