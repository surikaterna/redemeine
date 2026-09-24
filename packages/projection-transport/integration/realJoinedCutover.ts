import { MongoClient, type Document } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { MongoProjectionStore, type ProjectionDocumentRecord, type ProjectionLinkRecord } from '@redemeine/projection-runtime-store-mongodb';
import { inventoryDigest, MongoProjectionTransportStore, type AcceptedBaseline,
  type JoinedInventory, type ProjectionTransportDocument } from '../src';

const uri = process.env.REDEMEINE_MONGO_URI;
if (!uri) throw new Error('REDEMEINE_MONGO_URI required');
const client = new MongoClient(uri);
const name = `zz6h_${Date.now()}`;
const hash = `sha256:${'a'.repeat(64)}` as const;
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

async function run(): Promise<void> {
  await client.connect();
  const db = client.db(name);
  try {
    for (const projectionName of ['A', 'B']) {
      const queueId = `${name}.${projectionName}`;
      const manifest: ProjectionQueueRegistryManifest = { version: 1, queueId, manifestId: hash, registryGeneration: 'g1',
        identity: { version: 1, normalizedDefinitionRegistryDigest: hash,
          normalizedRuntimeConfigurationDigest: hash, executableCodeArtifactDigest: hash },
        definitions: [{ projectionName, generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true }],
        sourceStartAnchors: { [sourceId]: 1 } };
      const links = db.collection<Document & { _id: string }>(`${projectionName}_links`);
      const documents = db.collection<Document & { _id: string }>(`${projectionName}_documents`);
      await documents.insertOne({ _id: 'target', state: { count: 0 } });
      await links.insertOne({ _id: 'Order:one', targetDocId: 'target' });
      const draft = { projectionName, generation: 'g1', links, documents,
        expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }], maxLegacyRows: 2,
        approvedBy: 'operator', approvedAt: new Date().toISOString() };
      const item: JoinedInventory = { ...draft, approvedDigest: inventoryDigest(manifest, draft) };
      const baseline: AcceptedBaseline = { version: 2, kind: 'existing', queueBindingId: queueId, manifestId: hash,
        registryGeneration: 'g1', sourceId, lastAcceptedSequence: 0, startAnchor: 1, operator: 'operator',
        acceptedAt: new Date().toISOString(), acknowledgesUnverifiedHistoryAndCutoff: true, oldWriterStoppedBy: 'operator',
        oldWriterStoppedAt: new Date().toISOString(), queueTailReadinessReference: 'fixture',
        strategyScope: [{ projectionName, generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] };
      const transportCollection = db.collection<ProjectionTransportDocument>(`${projectionName}_transport`);
      const transport = new MongoProjectionTransportStore({ collection: transportCollection, mongoClient: client,
        manifest, joinedInventories: [item] });
      await transport.initialize();
      await transportCollection.insertOne({ _id: `baseline:${queueId}:${sourceId}`, kind: 'baseline', record: baseline });
      let rejected = false;
      try { await transport.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
      assert(rejected, 'Omitted seed admitted');
      assert(await transportCollection.findOne({ _id: `joined_adoption:${queueId}` }) === null, 'Omission wrote adoption');
      assert(await transportCollection.findOne({ _id: `coverage:${queueId}:${sourceId}` }) === null,
        'Omission wrote source coverage');
      assert(await db.collection(`${projectionName}_dedupe`).countDocuments({}) === 0,
        'Omission wrote own-record progress');
      const scopedId = [projectionName, 'g1', 'Order', 'one'].join('\u0000');
      await links.insertOne({ _id: scopedId, aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target',
        createdAt: new Date().toISOString(), v2Revision: 0 });
      await transport.verifyJoinedCutover(queueId, sourceId);
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
      await links.updateOne({ _id: scopedId }, { $set: { targetDocId: null, v2Revision: 1 } });
      await transport.verifyJoinedCutover(queueId, sourceId);
      const changed = new MongoProjectionTransportStore({ collection: transportCollection, mongoClient: client,
        manifest, joinedInventories: [{ ...item, approvedDigest: hash }] });
      rejected = false;
      try { await changed.verifyJoinedCutover(queueId, sourceId); } catch { rejected = true; }
      assert(rejected, 'Changed inventory admitted on restart');
    }
    console.log(JSON.stringify({ database: name, isolatedProjections: 2, omittedSeedRejected: true,
      adoptedAndRestartAfterUnsubscribe: true, postBTargetUpdated: true, changedDigestRejected: true }));
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

await run();
