import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import type { TapewormMongoRangeReader } from '../src/tapewormMongoRangeReader';
import { assertAcceptedBaseline, probeAcceptedTail, type AcceptedBaseline } from '../src/acceptedBaseline';

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
