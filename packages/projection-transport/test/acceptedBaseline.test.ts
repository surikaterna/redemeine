import type { ProjectionQueueRegistryManifest, ProjectionCompleteCommitRangeReader } from '@redemeine/projection-runtime-core';
import { assertAcceptedBaseline, probeAcceptedTail, type AcceptedBaseline } from '../src/acceptedBaseline';

const sourceId = '00000000-0000-4000-8000-000000000001';
const digest = `sha256:${'a'.repeat(64)}` as const;
const manifest: ProjectionQueueRegistryManifest = { version: 1, manifestId: digest, queueId: 'queue',
  registryGeneration: 'g1', identity: { version: 1, normalizedDefinitionRegistryDigest: digest,
    normalizedRuntimeConfigurationDigest: digest, executableCodeArtifactDigest: digest },
  definitions: [{ projectionName: 'own', generation: 'g1', definitionHash: digest, sourceSelectors: ['A'] }],
  sourceStartAnchors: {} };

function baseline(b: number): AcceptedBaseline {
  return { version: 1, queueBindingId: 'queue', manifestId: digest, registryGeneration: 'g1', sourceId,
    kind: 'existing', lastAcceptedSequence: b, startAnchor: b + 1, operator: 'operator',
    acceptedAt: '2026-09-24T00:00:00Z', acknowledgesUnverifiedHistoryAndCutoff: true,
    oldWriterStoppedBy: 'operator', oldWriterStoppedAt: '2026-09-24T00:00:00Z',
    queueTailReadinessReference: 'rabbit-binding-and-tail', tailReadyThrough: b + 1,
    strategyScope: [{ projectionName: 'own', generation: 'g1', strategy: 'own_record', stableSingleTarget: false }] };
}

test.each([-1, 0, 42])('accepted boundary B=%s probes only complete B+1', async (b) => {
  const record = baseline(b);
  assertAcceptedBaseline(record, manifest);
  const reads: number[] = [];
  const reader: ProjectionCompleteCommitRangeReader = { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    async readCompleteRange(request) {
      reads.push(request.afterSequence ?? -1);
      return { status: 'complete', encodedByteLength: 100, hasMore: false, continuationAfterSequence: b + 1,
        commits: [{ encodedByteLength: 100, commit: { streamId: sourceId,
          commitId: '00000000-0000-4000-8000-000000000002', commitSequence: b + 1,
          events: [{ eventId: '00000000-0000-4000-8000-000000000003', eventIndex: 0, streamVersion: b + 1,
            aggregateType: 'A', aggregateId: 'a', type: 'Added', payload: {}, timestamp: '2026-09-24T00:00:00Z' }] } }] };
    } };
  await probeAcceptedTail(record, reader, 200);
  expect(reads).toEqual([b]);
  await expect(probeAcceptedTail(record, { ...reader, async readCompleteRange(request) {
    return { status: 'incomplete', reason: 'history_unavailable', details: 'missing', continuationAfterSequence: request.afterSequence };
  } }, 200)).rejects.toThrow('Indexed complete source tail');
});

test('rejects mismatched anchor, unsupported strategy scope and unproven birth', () => {
  expect(() => assertAcceptedBaseline({ ...baseline(0), startAnchor: 0 }, manifest)).toThrow();
  expect(() => assertAcceptedBaseline({ ...baseline(0), strategyScope: [] }, manifest)).toThrow();
  expect(() => assertAcceptedBaseline({ ...baseline(-1), kind: 'birth' }, manifest)).toThrow('birth evidence');
  expect(() => assertAcceptedBaseline({ ...baseline(0), strategyScope: [{ projectionName: 'own', generation: 'g1',
    strategy: 'in_document', stableSingleTarget: false }] }, manifest)).toThrow();
});
