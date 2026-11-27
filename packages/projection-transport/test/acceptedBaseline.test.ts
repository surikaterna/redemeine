import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { createProjectionDispatchBindingProof, ProjectionDispatchBindingMismatchError } from '@redemeine/projection-runtime-core';
import { projectionChangesRequest } from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { createFakeMongoClient, InMemoryMongoCollection } from '../../projection-runtime-store-mongodb/test/mocks';
import type { TapewormMongoRangeReader } from '../src/tapewormMongoRangeReader';
import { assertAcceptedBaseline, probeAcceptedTail, type AcceptedBaseline } from '../src/acceptedBaseline';
import { MongoProjectionTransportStore, type MongoProjectionTransportStoreOptions, type ProjectionTransportDocument } from '../src/mongoTransportStore';

const sourceId = '00000000-0000-4000-8000-000000000001';
const digest = `sha256:${'a'.repeat(64)}` as const;
const manifest: ProjectionQueueRegistryManifest = { version: 1, manifestId: digest, queueId: 'queue',
  registryGeneration: 'g1', identity: { version: 1, normalizedDefinitionRegistryDigest: digest,
    normalizedRuntimeConfigurationDigest: digest, executableCodeArtifactDigest: digest },
  definitions: [{ projectionName: 'own', generation: 'g1', definitionHash: digest, sourceSelectors: ['A'] }],
  sourceStartAnchors: {} };

function baseline(b: number): AcceptedBaseline {
  return { version: 2, queueBindingId: 'queue', manifestId: digest, registryGeneration: 'g1', sourceId,
    kind: 'existing', lastAcceptedSequence: b, startAnchor: b + 1, operator: 'operator',
    acceptedAt: '2026-09-24T00:00:00Z', acknowledgesUnverifiedHistoryAndCutoff: true,
    oldWriterStoppedBy: 'operator', oldWriterStoppedAt: '2026-09-24T00:00:00Z',
    queueTailReadinessReference: 'operator-source-tail-reference',
    strategyScope: [{ projectionName: 'own', generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] };
}

test.each([-1, 0, 42])('accepted boundary B=%s probes indexed H even when empty', async (b) => {
  const record = baseline(b);
  assertAcceptedBaseline(record, manifest);
  const reads: number[] = [];
  const reader = { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    async probeSource(source: string, sequence: number) { expect(source).toBe(sourceId); reads.push(sequence); return b; }
  } as TapewormMongoRangeReader;
  expect(await probeAcceptedTail(record, reader)).toBe(b);
  expect(reads).toEqual([b]);
  await expect(probeAcceptedTail(record, { ...reader, async probeSource() {
    throw new Error('Accepted source boundary B is missing.');
  } })).rejects.toThrow('Accepted source boundary');
});

test('rejects mismatched anchor, unsupported strategy scope and unproven birth', () => {
  expect(() => assertAcceptedBaseline({ ...baseline(0), startAnchor: 0 }, manifest)).toThrow();
  expect(() => assertAcceptedBaseline({ ...baseline(0), strategyScope: [] }, manifest)).toThrow();
  expect(() => assertAcceptedBaseline({ ...baseline(-1), kind: 'birth' } as unknown as AcceptedBaseline, manifest)).toThrow('birth registration');
  expect(() => assertAcceptedBaseline({ ...baseline(0), strategyScope: [{ projectionName: 'own', generation: 'g1',
    strategy: 'in_document', stableSingleTarget: false }] }, manifest)).toThrow();
});

function admissionFixture() {
  const collection = new InMemoryMongoCollection<ProjectionTransportDocument>();
  const scope = [{ ...manifest.definitions[0]!, projectionChanges: 'views' }];
  const configured = { ...manifest, definitions: scope };
  const reader = { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    initialize: jest.fn(async () => {}), probeSource: async () => 0, getIndexName: () => 'source-index'
  } as unknown as TapewormMongoRangeReader;
  const store = new MongoProjectionTransportStore({
    collection: collection as unknown as MongoProjectionTransportStoreOptions['collection'],
    mongoClient: createFakeMongoClient(), manifest: configured, cutoverReadiness: { reader }
  });
  return { collection, proof: createProjectionDispatchBindingProof(configured), store, reader, commit: projectionChangesRequest().commit };
}

test('fresh admission initializes a matching immutable binding before reading accepted progress', async () => {
  const { collection, proof, store, commit } = admissionFixture();
  // Simulate a pre-provisioned accepted baseline without an initialized queue binding.
  const _id = `baseline:queue:${sourceId}`;
  await collection.updateOne({ _id }, { $setOnInsert: { kind: 'baseline', record: baseline(-1) } }, { upsert: true });
  expect(await store.readQueueBinding('queue')).toBeNull();
  await expect(store.admitForDispatch(commit, 'queue', proof)).resolves.toMatchObject({
    dispatch: true, boundDispatchProof: proof, coverage: { sequence: null }, startAnchor: 0
  });
  expect(collection.snapshot().map(row => row.kind).sort()).toEqual(['baseline', 'binding', 'coverage', 'source_probe']);
});

test('a mismatched expectation cannot initialize a fresh immutable binding or admit progress', async () => {
  const { collection, store, reader, commit } = admissionFixture();
  await expect(store.admitForDispatch(commit, 'queue', createProjectionDispatchBindingProof(manifest)))
    .rejects.toBeInstanceOf(ProjectionDispatchBindingMismatchError);
  expect(collection.operationLog).toEqual([]);
  expect(collection.snapshot()).toEqual([]);
  expect(reader.initialize).not.toHaveBeenCalled();
});

test('a conflicting persisted binding is not replaced and cannot admit progress', async () => {
  const { collection, proof, store, reader, commit } = admissionFixture();
  await store.bindImmutableManifest(manifest);
  const rows = structuredClone(collection.snapshot());
  await expect(store.admitForDispatch(commit, 'queue', proof)).rejects.toBeInstanceOf(ProjectionDispatchBindingMismatchError);
  expect(collection.snapshot()).toEqual(rows);
  expect(reader.initialize).not.toHaveBeenCalled();
});
