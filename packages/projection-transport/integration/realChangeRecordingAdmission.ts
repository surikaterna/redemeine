import assert from 'node:assert/strict';
import { createProjection, type ProjectionQueueRegistryManifest, type ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDedupeRecord,
  type ProjectionDocumentRecord, type ProjectionLinkRecord } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import type { Db, MongoClient } from 'mongodb';
import { MongoProjectionTransportStore, type ProjectionTransportDocument } from '../src/mongoTransportStore';
import { normalizeProjectionRegistryDefinitions, projectionDefinitionHash, projectionDefinitionRegistryDigest,
  projectionQueueRegistryDigest, projectionRuntimeConfigurationDigest } from '../src/registryIdentity';
import type { TapewormMongoRangeReader } from '../src/tapewormMongoRangeReader';

const artifact = `sha256:${'a'.repeat(64)}` as const;
const definition = createProjection('orders', () => ({ count: 0 }))
  .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
    Changed(draft) { draft.count += 1; }
  }).identity(() => 'one').deduplication({ strategy: 'own_record' }).buildCommitDefinition();

function register(queueId: string, sourceId: string, collection: string | undefined) {
  const policy = collection === undefined ? {} : { projectionChanges: collection };
  const definitions = [{ definition, generation: 'g1', ...policy }];
  const configurations = normalizeProjectionRegistryDefinitions(definitions, [{}]);
  const entries = [{ projectionName: definition.name, generation: 'g1', sourceSelectors: ['Order'],
    definitionHash: projectionDefinitionHash(configurations[0]!, artifact), ...policy }];
  const body: Omit<ProjectionQueueRegistryManifest, 'manifestId'> = {
    version: 1, queueId, registryGeneration: 'r1', definitions: entries, sourceStartAnchors: { [sourceId]: 0 },
    identity: { version: 1, executableCodeArtifactDigest: artifact,
      normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(entries),
      normalizedRuntimeConfigurationDigest: projectionRuntimeConfigurationDigest(configurations) }
  };
  return { definitions, manifest: { ...body, manifestId: projectionQueueRegistryDigest(body) } };
}

export async function checkRealChangeRecordingAdmission(
  client: MongoClient, db: Db, reader: TapewormMongoRangeReader, commit: ProjectionSourceCommit
): Promise<void> {
  for (const [queueId, boundCollection, localCollection] of [
    ['bound_disabled', undefined, 'views'],
    ['bound_enabled', 'views', undefined],
    ['wrong_collection', 'views', 'other'],
    ['matching_enabled', 'views', 'views'],
    ['matching_disabled', undefined, undefined]
  ] as const) {
    const bound = register(queueId, commit.streamId, boundCollection);
    const local = register(queueId, commit.streamId, localCollection);
    const rows = db.collection<ProjectionTransportDocument>(`${queueId}_transport`);
    const sourceOrder = new MongoProjectionTransportStore({
      collection: rows, mongoClient: client, manifest: bound.manifest, cutoverReadiness: { reader }
    });
    await sourceOrder.installAcceptedBaseline({
      version: 2, kind: 'existing', queueBindingId: queueId, manifestId: bound.manifest.manifestId,
      registryGeneration: 'r1', sourceId: commit.streamId, lastAcceptedSequence: -1, startAnchor: 0,
      operator: 'integration', acceptedAt: 'now', acknowledgesUnverifiedHistoryAndCutoff: true,
      oldWriterStoppedBy: 'integration', oldWriterStoppedAt: 'now', queueTailReadinessReference: 'indexed',
      strategyScope: [{ projectionName: 'orders', generation: 'g1', strategy: 'own_record', stableSingleTarget: true }]
    });
    const collection = db.collection<ProjectionDocumentRecord<{ count: number }>>(`${queueId}_documents`);
    const dedupeCollection = db.collection<ProjectionDedupeRecord>(`${queueId}_dedupe`);
    const linkCollection = db.collection<ProjectionLinkRecord>(`${queueId}_links`);
    const changeCollection = db.collection<MongoProjectionChangesRecord>(`${queueId}_changes`);
    const store = new MongoProjectionStore({ collection, dedupeCollection, linkCollection, changeCollection, mongoClient: client });
    const worker = createProjectionCommitCoordinator({ ...local, queueBindingId: queueId, sourceOrder, store, rangeReader: reader,
      maxCommits: 1, maxBytes: 100_000 });
    const before = await rows.find({}).sort({ _id: 1 }).toArray();
    const result = await worker.process(commit);
    const matches = boundCollection === localCollection;
    assert.equal(result.status, matches ? 'completed' : 'terminal', queueId);
    assert.deepEqual(await store.load('one'), matches ? { count: commit.events.length } : null, queueId);
    assert.equal(await dedupeCollection.countDocuments(), matches ? 1 : 0, queueId);
    assert.deepEqual((await changeCollection.find().toArray()).map(({ collection }) => collection),
      matches && boundCollection !== undefined ? [boundCollection] : [], queueId);
    assert.equal(await sourceOrder.loadCoveredThrough(queueId, commit.streamId), matches ? 0 : null, queueId);
    if (!matches) assert.deepEqual(await rows.find({}).sort({ _id: 1 }).toArray(), before, queueId);
  }
}
