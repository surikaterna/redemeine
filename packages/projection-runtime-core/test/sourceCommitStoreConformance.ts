import type {
  CommitProjectionSourceCommitRequest,
  ProjectionSourceCommitStorePort,
  ProjectionUuidBase64Url22
} from '../src';

const sourceId = '00000000-0000-4000-8000-000000000001';
const encodedSource = 'AAAAAAAAQACAAAAAAAAAAQ' as ProjectionUuidBase64Url22;

const baseRequest = (strategy: CommitProjectionSourceCommitRequest<{ value: number }>['progress']): CommitProjectionSourceCommitRequest<{ value: number }> => ({
  version: 1,
  mode: 'atomic-all',
  projectionName: 'orders',
  projectionGeneration: 'v2',
  commit: {
    streamId: sourceId,
    commitId: '00000000-0000-4000-8000-000000000002',
    commitSequence: 0,
    events: [{
      eventId: '00000000-0000-4000-8000-000000000003',
      eventIndex: 0,
      streamVersion: 0,
      aggregateType: 'Order',
      aggregateId: 'one',
      type: 'Opened',
      payload: {},
      timestamp: '2026-09-22T00:00:00.000Z'
    }]
  },
  finalDocuments: [{ targetDocumentId: 'target-a', expectedRevision: null, finalDocument: { value: 1 } }],
  stagedLinks: [{
    operation: 'subscribe',
    targetDocumentId: 'target-a',
    aggregateType: 'Order',
    aggregateId: 'one',
    expectedRevision: null
  }],
  progress: strategy
});

export const defineProjectionSourceCommitStoreConformance = (
  label: string,
  createStore: () => ProjectionSourceCommitStorePort<{ value: number }>,
  dedupeOperationCount?: () => number
): void => {
  describe(`${label} projection source commit store`, () => {
    test('commits sequence zero, state, inline progress, and link atomically', async () => {
      const store = createStore();
      const request = baseRequest({
        strategy: 'in_document',
        targets: [{ targetDocumentId: 'target-a', expected: {}, final: { [encodedSource]: 0 } }]
      });
      const result = await store.commitProjectionSourceCommit(request);
      expect(result.status).toBe('committed');
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: ['target-a'],
        links: [{ aggregateType: 'Order', aggregateId: 'one' }], progressStrategy: 'in_document'
      });
      expect(snapshot.targets).toEqual([{ targetDocumentId: 'target-a', revision: 1, state: { value: 1 }, sourceProgress: { [encodedSource]: 0 } }]);
      expect(snapshot.links[0]).toMatchObject({ targetDocumentId: 'target-a', revision: 1 });
    });

    test('rolls back all writes on a late link fence conflict', async () => {
      const store = createStore();
      const first = baseRequest({ strategy: 'none' });
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      const conflicting = {
        ...first,
        commit: { ...first.commit, commitSequence: 3 },
        finalDocuments: [{ targetDocumentId: 'target-b', expectedRevision: null, finalDocument: { value: 2 } }]
      };
      expect((await store.commitProjectionSourceCommit(conflicting)).status).toBe('rejected');
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: ['target-b'], links: [], progressStrategy: 'none'
      });
      expect(snapshot.targets[0]).toMatchObject({ revision: null, state: null });
    });

    test('advances one own-record scalar for a no-target commit', async () => {
      const store = createStore();
      const base = baseRequest({
        strategy: 'own_record',
        source: { sourceId, expectedSequence: null, finalSequence: 7 }
      });
      const request = { ...base, finalDocuments: [], stagedLinks: [] };
      expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: [], links: [],
        progressStrategy: 'own_record', sourceId
      });
      expect(snapshot.ownRecordSequence).toBe(7);
    });

    test('none performs no projection dedupe operations', async () => {
      const store = createStore();
      const before = dedupeOperationCount?.() ?? 0;
      await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: [], links: [], progressStrategy: 'none'
      });
      await store.commitProjectionSourceCommit({ ...baseRequest({ strategy: 'none' }), finalDocuments: [], stagedLinks: [] });
      expect(dedupeOperationCount?.() ?? 0).toBe(before);
    });
  });
};
