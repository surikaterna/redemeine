import { defineProjectionSourceCommitStoreConformance } from '../../projection-runtime-core/test/sourceCommitStoreConformance';
import { InMemoryProjectionStore } from '../src';

defineProjectionSourceCommitStoreConformance('in-memory', () => new InMemoryProjectionStore());

test('warning callbacks are rate limited and best effort', async () => {
  let calls = 0;
  const store = new InMemoryProjectionStore<{ value: number }>({
    onDedupeWarning: () => {
      calls += 1;
      throw new Error('telemetry unavailable');
    }
  });
  const request = {
    version: 1 as const,
    mode: 'atomic-all' as const,
    projectionName: 'warnings',
    projectionGeneration: 'v1',
    commit: {
      streamId: '00000000-0000-4000-8000-000000000001', commitId: '00000000-0000-4000-8000-000000000002',
      commitSequence: 0,
      events: [{ eventId: '00000000-0000-4000-8000-000000000003', eventIndex: 0, streamVersion: 0,
        aggregateType: 'A', aggregateId: 'a', type: 'E', payload: {}, timestamp: '2026-09-22T00:00:00.000Z' }] as const
    },
    finalDocuments: [{ targetDocumentId: 'one', expectedRevision: null, finalDocument: { value: 1 } }],
    stagedLinks: [],
    progress: {
      strategy: 'in_document' as const,
      warnings: { warnAtSourceCount: 0, warnAtMetadataBytes: 0 },
      targets: [{ targetDocumentId: 'one', expected: {}, final: { AAAAAAAAAAAAAAAAAAAAAA: 0 } }]
    }
  };
  expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
  expect(calls).toBe(2);
});
