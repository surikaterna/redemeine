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
export function joinBindingConfiguration(set: boolean, recording: boolean, source: string, queueId = 'bind-scope', attachCandidate = false) {
  const builder = createProjection('boards', (id): State => ({ id, visits: [] }))
    .from(board, {}).join(order, { ordinary(draft, event, ctx) {
      draft.visits.push('ordinary');
      if (attachCandidate && draft.id === 'C') ctx.subscribeTo(order, event.aggregateId);
    } });
  if (set) builder.joinRight(order, attachCandidate ? { ordinary: (event) => event.sequence === 2 ? 'C' : null } : {});
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

type BindingFixture = {
  readonly scope: typeof scope;
  readonly initialView: (id: string) => Record<string, unknown>;
  readonly eventAt: (sequence: number) => Pick<TapewormProjectionCommit['events'][number], 'type' | 'payload'>;
};

async function sourceFixture(db: Db, source: string, queueId: string, deferTail: boolean, eventAt: BindingFixture['eventAt']) {
  const collection = db.collection<TapewormProjectionCommit>('source');
  await collection.createIndex({ streamId: 1, commitSequence: 1 }, { name: 'sourceRange', unique: true });
  const commits = [0, 1, 2].map((seq) => ({
    id: randomUUID(), streamId: source, partitionId: queueId, commitSequence: seq,
    events: [{ ...path, id: randomUUID(), ...eventAt(seq), version: seq, timestamp: new Date().toISOString() }]
  }));
  await collection.insertMany(deferTail ? commits.slice(0, 1) : commits);
  const reader = createTapewormMongoCompleteCommitRangeReader({ collection, partitionId: queueId });
  return { reader, tail: commits.slice(1), collection };
}

export async function seedJoinBinding(db: Db, client: MongoClient, boundSet: boolean,
  registry: ProjectionQueueRegistryManifest, source: string, deferTail = false, deferAdoption = false, fixture?: BindingFixture) {
  const targetScope = fixture?.scope ?? scope;
  const { queueId, manifestId, registryGeneration } = registry;
  const collection = db.collection<ProjectionTransportDocument>('transport');
  const joinedApprovals = db.collection<JoinedApproval>('approvals');
  const links = db.collection<Document & { _id: string }>(boundSet ? 'members' : 'scalar');
  const docs = db.collection<Document & { _id: string }>('views');
  await docs.insertMany(['A', 'B'].map((id) => ({ _id: id, state: fixture?.initialView(id) ?? { id, visits: [] }, updatedAt: new Date().toISOString() })));
  const item = { ...targetScope, linkNamespace: links.namespace, documentNamespace: docs.namespace, maxLinkRows: 1 };
  const set = { ...path, targetDocumentIds: ['A', 'B'] };
  const scalar = { ...path, targetDocId: 'A' };
  const inventory = boundSet
    ? { ...item, format: 'set-v1' as const, expectedSets: [set], maxEdges: 2, maxTargetBytes: 2048 }
    : { ...item, expected: [scalar] };
  await links.insertOne(boundSet ? joinedMembershipSeedRow(targetScope, set) : {
    _id: [targetScope.projectionName, targetScope.generation, path.aggregateType, orderId].join('\0'),
    ...scalar, createdAt: new Date().toISOString(), v2Revision: 0
  });
  const indexed = await sourceFixture(db, source, queueId, deferTail, fixture?.eventAt ?? (() => ({ type: 'ordinary', payload: {} })));
  const { reader } = indexed;
  const sourceOrder = new MongoProjectionTransportStore({ collection, joinedApprovals, mongoClient: client,
    manifest: registry, joinedInventories: [{ ...targetScope, links, documents: docs }], cutoverReadiness: { reader } });
  await sourceOrder.installAcceptedBaseline({ version: 2, kind: 'existing', queueBindingId: queueId, manifestId, registryGeneration,
    sourceId: source, startAnchor: 1, lastAcceptedSequence: 0, operator: 'test', acceptedAt: new Date().toISOString(),
    acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedAt: new Date().toISOString(), oldWriterStoppedBy: 'test',
    queueTailReadinessReference: 'indexed fixture', strategyScope: [{ ...targetScope, strategy: 'own_record', stableSingleTarget: false }] });
  const approval = { _id: `joined_approval:${queueId}`, kind: 'joined_approval' as const, queueBindingId: queueId, manifestId,
    registryGeneration, approvalNamespace: joinedApprovals.namespace, transportNamespace: collection.namespace,
    approvedBy: 'test', approvedAt: new Date().toISOString(), inventories: [inventory] };
  await joinedApprovals.insertOne({ ...approval, digest: approvalDigest(approval) });
  if (!deferAdoption) await sourceOrder.verifyJoinedCutover(queueId, source);
  return { indexed, docs, links, collection, sourceOrder };
}

export async function runJoinBinding(db: Db, client: MongoClient, boundSet: boolean, recording: boolean) {
  const source = randomUUID();
  const bound = joinBindingConfiguration(boundSet, recording, source);
  const wrong = joinBindingConfiguration(!boundSet, recording, source);
  const { queueId } = bound.manifest;
  const { indexed: { reader }, docs, links, collection, sourceOrder } = await seedJoinBinding(db, client, boundSet, bound.manifest, source);
  const range = await reader.readCompleteRange({ sourceId: source, afterSequence: 1, throughSequence: 2, maxCommits: 1, maxBytes: 100_000 });
  assert.equal(range.status, 'complete');
  const later = range.commits[0]!.commit;
  const changes = db.collection('changes');
  const progress = db.collection('progress');
  const store = new MongoProjectionStore<State>({ collection: db.collection<ProjectionDocumentRecord<State>>('views'),
    linkCollection: db.collection('scalar'), joinMembershipCollection: db.collection<ProjectionJoinMembershipRecord>('members'),
    dedupeCollection: db.collection('progress'), changeCollection: db.collection('changes'), mongoClient: client });
  const make = (options: ReturnType<typeof joinBindingConfiguration>) => createProjectionCommitCoordinator({
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
