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
  createStore: () => ProjectionSourceCommitStorePort<{ value: number }> | Promise<ProjectionSourceCommitStorePort<{ value: number }>>,
  dedupeOperationCount?: () => number
): void => {
  describe(`${label} projection source commit store`, () => {
    test('commits sequence zero, state, inline progress, and link atomically', async () => {
      const store = await createStore();
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
      const store = await createStore();
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
      const store = await createStore();
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

    test('supports sparse sequences, marker deletion, and fenced unsubscribe', async () => {
      const store = await createStore();
      const first = baseRequest({
        strategy: 'in_document',
        targets: [{ targetDocumentId: 'target-a', expected: {}, final: { [encodedSource]: 0 } }]
      });
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      const secondSource = 'AAAAAAAAQACAAAAAAAAAAg' as ProjectionUuidBase64Url22;
      const second: CommitProjectionSourceCommitRequest<{ value: number }> = {
        ...first,
        commit: { ...first.commit, commitSequence: 9 },
        finalDocuments: [{ targetDocumentId: 'target-a', expectedRevision: 1, finalDocument: { value: 9 } }],
        stagedLinks: [{ ...first.stagedLinks[0]!, operation: 'unsubscribe', expectedRevision: 1 }],
        progress: {
          strategy: 'in_document',
          targets: [{ targetDocumentId: 'target-a', expected: { [encodedSource]: 0 }, final: { [secondSource]: 9 } }]
        }
      };
      expect((await store.commitProjectionSourceCommit(second)).status).toBe('committed');
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: ['target-a'],
        links: [{ aggregateType: 'Order', aggregateId: 'one' }], progressStrategy: 'in_document'
      });
      expect(snapshot.targets[0]).toMatchObject({ revision: 2, state: { value: 9 }, sourceProgress: { [secondSource]: 9 } });
      expect(snapshot.links[0]).toMatchObject({ targetDocumentId: null, revision: 2 });
    });

    test('rejects a stale whole-map expectation without publishing state', async () => {
      const store = await createStore();
      const first = baseRequest({
        strategy: 'in_document',
        targets: [{ targetDocumentId: 'target-a', expected: {}, final: { [encodedSource]: 0 } }]
      });
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      const stale = {
        ...first,
        commit: { ...first.commit, commitSequence: 4 },
        finalDocuments: [{ targetDocumentId: 'target-a', expectedRevision: 1, finalDocument: { value: 4 } }],
        stagedLinks: [],
        progress: {
          strategy: 'in_document' as const,
          targets: [{ targetDocumentId: 'target-a', expected: {}, final: { [encodedSource]: 4 } }]
        }
      };
      expect((await store.commitProjectionSourceCommit(stale)).status).toBe('rejected');
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: ['target-a'], links: [], progressStrategy: 'in_document'
      });
      expect(snapshot.targets[0]).toMatchObject({ revision: 1, state: { value: 1 }, sourceProgress: { [encodedSource]: 0 } });
    });

    test.each([
      ['progress-only target', ['target-a'], ['target-b']],
      ['mixed marked and unmarked documents', ['target-a', 'target-b'], ['target-a']]
    ])('rejects malformed in-document relationships: %s', async (_label, documentIds, progressIds) => {
      const store = await createStore();
      const base = baseRequest({ strategy: 'in_document', targets: [] });
      const malformed: CommitProjectionSourceCommitRequest<{ value: number }> = {
        ...base,
        finalDocuments: documentIds.map((targetDocumentId) => ({
          targetDocumentId,
          expectedRevision: null,
          finalDocument: { value: 1 }
        })),
        stagedLinks: [],
        progress: {
          strategy: 'in_document',
          targets: progressIds.map((targetDocumentId) => ({
            targetDocumentId,
            expected: {},
            final: { [encodedSource]: 0 }
          }))
        }
      };
      expect(await store.commitProjectionSourceCommit(malformed)).toMatchObject({
        status: 'rejected', category: 'terminal', retryable: false
      });
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: ['target-a', 'target-b'],
        links: [], progressStrategy: 'in_document'
      });
      expect(snapshot.targets).toEqual([
        { targetDocumentId: 'target-a', revision: null, state: null, sourceProgress: {} },
        { targetDocumentId: 'target-b', revision: null, state: null, sourceProgress: {} }
      ]);
    });

    test('none performs no projection dedupe operations', async () => {
      const store = await createStore();
      const before = dedupeOperationCount?.() ?? 0;
      await store.loadProjectionSourceCommitSnapshot({
        projectionName: 'orders', projectionGeneration: 'v2', targetDocumentIds: [], links: [], progressStrategy: 'none'
      });
      await store.commitProjectionSourceCommit({ ...baseRequest({ strategy: 'none' }), finalDocuments: [], stagedLinks: [] });
      expect(dedupeOperationCount?.() ?? 0).toBe(before);
    });
  });
};
