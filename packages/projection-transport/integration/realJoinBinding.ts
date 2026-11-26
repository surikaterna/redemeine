import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjection, createProjectionDispatchBindingProof, type ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { MongoProjectionStore, type ProjectionDocumentRecord, type ProjectionJoinMembershipRecord } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { Db, Document, MongoClient } from 'mongodb';
import {
  approvalDigest, createTapewormMongoCompleteCommitRangeReader, joinedMembershipSeedRow, MongoProjectionTransportStore,
  normalizeProjectionRegistryDefinitions, projectionDefinitionHash, projectionDefinitionRegistryDigest,
  projectionQueueRegistryDigest, projectionRuntimeConfigurationDigest, type JoinedApproval, type ProjectionTransportDocument,
  type TapewormProjectionCommit
} from '../src';
import { orderId, path, type State } from './joinMembershipFixture';

const scope = { projectionName: 'boards', generation: 'g1' };
const board = { aggregateType: 'Board', pure: { eventProjectors: {} } };
const order = { aggregateType: 'Order', pure: { eventProjectors: { ordinary() {} } } };
const artifact = `sha256:${'a'.repeat(64)}` as const;
const queueId = 'bind-scope';

function configuration(set: boolean, recording: boolean, source: string) {
  const builder = createProjection('boards', (id): State => ({ id, visits: [] }))
    .from(board, {}).join(order, { ordinary(draft) { draft.visits.push('ordinary'); } });
  if (set) builder.joinRight(order, {});
  const policy = recording ? { projectionChanges: 'join-changes' } : {};
  const definitions = [{ definition: builder.deduplication({ strategy: 'own_record' }).build(), generation: scope.generation, ...policy }];
  const config = normalizeProjectionRegistryDefinitions(definitions, [{}]);
  const entries = [{ ...scope, joined: true as const, ...(set ? { joinMembership: 'set-v1' as const } : {}), ...policy,
    sourceSelectors: ['Board', 'Order'], definitionHash: projectionDefinitionHash(config[0]!, artifact) }];
  const body: Omit<ProjectionQueueRegistryManifest, 'manifestId'> = { version: 1, queueId, registryGeneration: 'registry-v1',
    definitions: entries, sourceStartAnchors: { [source]: 1 },
    identity: { version: 1, normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(entries),
      normalizedRuntimeConfigurationDigest: projectionRuntimeConfigurationDigest(config), executableCodeArtifactDigest: artifact } };
  return { definitions, manifest: { ...body, manifestId: projectionQueueRegistryDigest(body) } };
}

async function sourceFixture(db: Db, source: string) {
  const collection = db.collection<TapewormProjectionCommit>('source');
  await collection.createIndex({ streamId: 1, commitSequence: 1 }, { name: 'sourceRange', unique: true });
  await collection.insertMany([0, 1, 2].map((seq) => ({
    id: randomUUID(), streamId: source, partitionId: queueId, commitSequence: seq,
    events: [{ ...path, id: randomUUID(), type: 'ordinary', version: seq, timestamp: new Date().toISOString(), payload: {} }]
  })));
  const reader = createTapewormMongoCompleteCommitRangeReader({ collection, partitionId: queueId });
  const range = await reader.readCompleteRange({ sourceId: source, afterSequence: 1, throughSequence: 2, maxCommits: 1, maxBytes: 100_000 });
  assert.equal(range.status, 'complete');
  return { reader, later: range.commits[0]!.commit };
}

async function seedBinding(db: Db, client: MongoClient, boundSet: boolean, registry: ProjectionQueueRegistryManifest, source: string) {
  const collection = db.collection<ProjectionTransportDocument>('transport');
  const joinedApprovals = db.collection<JoinedApproval>('approvals');
  const links = db.collection<Document & { _id: string }>(boundSet ? 'members' : 'scalar');
  const docs = db.collection<Document & { _id: string }>('views');
  await docs.insertMany(['A', 'B'].map((id) => ({ _id: id, state: { id, visits: [] }, updatedAt: new Date().toISOString() })));
  const item = { ...scope, linkNamespace: links.namespace, documentNamespace: docs.namespace, maxLinkRows: 1 };
  const set = { ...path, targetDocumentIds: ['A', 'B'] };
  const scalar = { ...path, targetDocId: 'A' };
  const inventory = boundSet
    ? { ...item, format: 'set-v1' as const, expectedSets: [set], maxEdges: 2, maxTargetBytes: 2048 }
    : { ...item, expected: [scalar] };
  await links.insertOne(boundSet ? joinedMembershipSeedRow(scope, set) : {
    _id: [scope.projectionName, scope.generation, path.aggregateType, orderId].join('\0'),
    ...scalar, createdAt: new Date().toISOString(), v2Revision: 0
  });
  const { reader, later } = await sourceFixture(db, source);
  const { manifestId, registryGeneration } = registry;
  const sourceOrder = new MongoProjectionTransportStore({ collection, joinedApprovals, mongoClient: client,
    manifest: registry, joinedInventories: [{ ...scope, links, documents: docs }], cutoverReadiness: { reader } });
  await sourceOrder.installAcceptedBaseline({ version: 2, kind: 'existing', queueBindingId: queueId, manifestId, registryGeneration,
    sourceId: source, startAnchor: 1, lastAcceptedSequence: 0, operator: 'test', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedAt: new Date().toISOString(), oldWriterStoppedBy: 'test',
    queueTailReadinessReference: 'indexed fixture', strategyScope: [{ ...scope, strategy: 'own_record', stableSingleTarget: false }] });
  const approval = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId, manifestId,
    registryGeneration, approvalNamespace: joinedApprovals.namespace, transportNamespace: collection.namespace,
    approvedBy: 'test', approvedAt: new Date().toISOString(), inventories: [inventory] };
  await joinedApprovals.insertOne({ ...approval, digest: approvalDigest(approval) });
  await sourceOrder.verifyJoinedCutover(queueId, source);
  return { reader, later, docs, links, collection, sourceOrder };
}

export async function runJoinBinding(db: Db, client: MongoClient, boundSet: boolean, recording: boolean) {
  const source = randomUUID();
  const bound = configuration(boundSet, recording, source);
  const wrong = configuration(!boundSet, recording, source);
  const { reader, later, docs, links, collection, sourceOrder } = await seedBinding(db, client, boundSet, bound.manifest, source);
  const changes = db.collection('changes');
  const progress = db.collection('progress');
  const store = new MongoProjectionStore<State>({ collection: db.collection<ProjectionDocumentRecord<State>>('views'),
    linkCollection: db.collection('scalar'), joinMembershipCollection: db.collection<ProjectionJoinMembershipRecord>('members'),
    dedupeCollection: db.collection('progress'), changeCollection: db.collection('changes'), mongoClient: client });
  const make = (options: ReturnType<typeof configuration>) => createProjectionCommitCoordinator({
    ...options, queueBindingId: queueId, sourceOrder, store, rangeReader: reader, maxCommits: 4, maxBytes: 100_000
  });
  const beforeLinks = await links.find().toArray();
  await assert.rejects(sourceOrder.admitForDispatch(later, queueId,
    undefined as unknown as ReturnType<typeof createProjectionDispatchBindingProof>), /missing dispatch proof/);
  for (const manifest of [wrong.manifest, { ...wrong.manifest, manifestId: bound.manifest.manifestId, identity: bound.manifest.identity }]) {
    const result = await make({ ...wrong, manifest }).process(later);
    assert.equal(result.status, 'terminal', JSON.stringify(result));
    assert.deepEqual(result.processedSequences, []);
  }
  assert.equal(await collection.countDocuments({ kind: 'coverage' }), 0);
  assert.equal(await progress.countDocuments(), 0);
  assert.equal(await changes.countDocuments(), 0);
  assert.deepEqual(await links.find().toArray(), beforeLinks);
  assert.equal(await docs.countDocuments({ v2Revision: { $exists: true } }), 0);

  const ordered = await make(bound).process(later);
  assert.equal(ordered.status, 'completed', JSON.stringify(ordered));
  assert.deepEqual(ordered.processedSequences, [1, 2]);
  assert.equal(await sourceOrder.loadCoveredThrough(queueId, source), 2);
  assert.equal((await progress.findOne({ sourceId: source }))?.commitSequence, 2);
  assert.equal(await changes.countDocuments(), recording ? 2 : 0);
  const views = await docs.find().sort({ _id: 1 }).toArray();
  assert.deepEqual(views.map((doc) => doc.state.visits.length), [2, boundSet ? 2 : 0]);
  console.log(JSON.stringify({ scenario: 'binding-proof', boundSet, recording, mismatches: 2, recovered: ordered.processedSequences }));
}
