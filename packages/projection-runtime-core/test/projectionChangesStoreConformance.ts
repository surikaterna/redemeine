import {
  projectionChangesResumeToken,
  projectionUuidToBase64Url22,
  type CommitProjectionSourceCommitRequest,
  type ProjectionChangesRecord,
  type ProjectionSourceCommitStorePort
} from '../src';
import { withSerializerLikeTargetIds, withTarget } from './projectionChangeMetadataFixtures';

type State = { value: number; kept?: string };
type Request = CommitProjectionSourceCommitRequest<State>;
const sourceId = '00000000-0000-4000-8000-000000000001';
const sourceKey = projectionUuidToBase64Url22(sourceId);

export function projectionChangesRequest(sequence = 0): Request {
  const commitId = `00000000-0000-4000-8000-${String(sequence + 20).padStart(12, '0')}`;
  const eventId = `00000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}`;
  const expectedRevision = sequence === 0 ? null : sequence;
  const value = sequence + 1;
  return {
    version: 1, mode: 'atomic-all', projectionName: 'orders', projectionGeneration: 'g1',
    commit: {
      streamId: sourceId, commitId, commitSequence: sequence,
      events: [{ eventId, eventIndex: 0, streamVersion: sequence, aggregateType: 'Order',
        aggregateId: 'one', type: 'Changed', payload: {}, timestamp: '2026-09-22T00:00:00.000Z' }]
    },
    finalDocuments: [{ targetDocumentId: 'one', expectedRevision, finalDocument: { value, kept: 'yes' } }],
    stagedLinks: sequence === 0
      ? [{ operation: 'subscribe', targetDocumentId: 'one', aggregateType: 'Detail', aggregateId: 'related', expectedRevision: null }]
      : [],
    progress: { strategy: 'none' },
    additionalWrites: [{
      kind: 'projection_changes', collection: 'order_views',
      targets: [{ targetDocumentId: 'one', transitions: [{
        eventId, eventIndex: 0, changeType: sequence === 0 ? 'create' : 'update',
        patch: sequence === 0 ? [{ op: 'add', path: '', value: { value, kept: 'yes' } }] : [{ op: 'replace', path: '/value', value }]
      }] }]
    }]
  };
}

export const changeSnapshotRequest = {
  projectionName: 'orders', projectionGeneration: 'g1', targetDocumentIds: ['one'],
  links: [{ aggregateType: 'Detail', aggregateId: 'related' }], progressStrategy: 'own_record',
  sourceId
} as const;

export function defineProjectionChangesStoreConformance(
  label: string,
  create: () => { store: ProjectionSourceCommitStorePort<State>; records: () => readonly ProjectionChangesRecord[] }
): void {
  describe(`${label} atomic projection changes`, () => {
    test('rejects a NUL target ID without writing a change', async () => {
      const { store, records } = create();
      const request = withTarget(projectionChangesRequest(), 'order\0two');
      expect(await store.commitProjectionSourceCommit(request)).toMatchObject({
        status: 'rejected', category: 'terminal', retryable: false, reason: expect.stringMatching(/metadata|keys collide/)
      });
      expect(records()).toEqual([]);
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ state: null, revision: null }], links: [{ revision: null }], ownRecordSequence: null
      });
    });

    test('replay preserves serializer and prototype named revision keys as own properties', async () => {
      const { store } = create();
      const ids = ['_bsontype', '__proto__'];
      const request = withSerializerLikeTargetIds(projectionChangesRequest(), ids);
      const first = await store.commitProjectionSourceCommit(request);
      const replay = await store.commitProjectionSourceCommit(request);
      expect(first).toMatchObject({ status: 'committed' });
      expect(replay).toEqual(first);
      if (replay.status !== 'committed') throw new Error('expected a committed receipt');
      for (const id of ids) expect(Object.getOwnPropertyDescriptor(replay.documentRevisions, id)?.value).toBe(1);
    });

    test('serializer-like target IDs remain valid without a change receipt', async () => {
      const { store, records } = create();
      const { additionalWrites, ...request } = withTarget(projectionChangesRequest(), '_bsontype');
      const result = await store.commitProjectionSourceCommit(request);
      expect(result).toMatchObject({ status: 'committed' });
      if (result.status !== 'committed') return;
      expect(result.documentRevisions._bsontype).toBe(1);
      expect(records()).toEqual([]);
    });

    test.each([true, false])('runtime no-op advances revision and inline progress with recording=%s', async (recording) => {
      const { store, records } = create();
      const { additionalWrites: _ignored, ...first } = projectionChangesRequest();
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed'); // Older caller, no hint or feed.
      const { additionalWrites, ...next } = projectionChangesRequest(1);
      const target = additionalWrites![0].targets[0]!;
      const transitions = [{ ...target.transitions[0]!, changeType: 'noop' as const, patch: [] }];
      const request: Request = {
        ...next,
        finalDocuments: [{ ...first.finalDocuments[0]!, expectedRevision: 1, statePatch: { kind: 'ordered', transitions } }],
        progress: { strategy: 'in_document', targets: [{ targetDocumentId: 'one', expected: {}, final: { [sourceKey]: 1 } }] },
        ...(recording ? { additionalWrites: [{ ...additionalWrites![0], targets: [{ ...target, transitions }] }] } : {})
      };
      expect(await store.commitProjectionSourceCommit(request)).toMatchObject({ status: 'committed', documentRevisions: { one: 2 } });
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ state: { value: 1, kept: 'yes' }, revision: 2, sourceProgress: { [sourceKey]: 1 } }]
      });
      expect(records()).toHaveLength(Number(recording));
    });

    test('the runtime full-state hint preserves a nonportable value without enabling history', async () => {
      const { store, records } = create();
      const { additionalWrites: _ignored, ...request } = projectionChangesRequest();
      const document = request.finalDocuments[0]!;
      const finalDocument = { ...document.finalDocument, shippedAt: new Date('2026-11-18T00:00:00Z') };
      expect(await store.commitProjectionSourceCommit({ ...request, finalDocuments: [{ ...document, finalDocument,
        statePatch: { kind: 'full', reason: 'nonportable-state' }
      }] })).toMatchObject({ status: 'committed' });
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ state: finalDocument, revision: 1 }]
      });
      expect(records()).toEqual([]);
    });
    test('commits feed, result, document, link and inline progress together, grouped by source commit', async () => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      const append = first.additionalWrites![0];
      const secondEvent = { ...first.commit.events[0], eventId: 'event-2', eventIndex: 1, streamVersion: 1 };
      const [originalTarget] = append.targets;
      const secondTarget = { targetDocumentId: 'two', transitions: originalTarget!.transitions };
      const request: Request = {
        ...first,
        commit: { ...first.commit, events: [first.commit.events[0], secondEvent] },
        finalDocuments: [...first.finalDocuments, { ...first.finalDocuments[0]!, targetDocumentId: 'two' }],
        additionalWrites: [{ ...append, targets: [{
          ...originalTarget!, transitions: [...originalTarget!.transitions, {
            eventId: secondEvent.eventId, eventIndex: 1, changeType: 'noop', patch: []
          }]
        }, secondTarget] }],
        progress: { strategy: 'in_document', targets: ['one', 'two'].map((targetDocumentId) =>
          ({ targetDocumentId, expected: {}, final: { [sourceKey]: 0 } })) }
      };
      const result = await store.commitProjectionSourceCommit(request);
      expect(result).toMatchObject({ status: 'committed', documentRevisions: { one: 1, two: 1 }, linkRevisions: { 'Detail:related': 1 } });
      const [record] = records();
      expect(records()).toHaveLength(1);
      expect(record).toMatchObject({
        projectionName: 'orders', projectionGeneration: 'g1', collection: 'order_views', sourceId, commitSequence: 0,
        commitId: first.commit.commitId, resumeToken: projectionChangesResumeToken(first),
        targets: [
          { targetDocumentId: 'one', previousRevision: null, revision: 1, transitions: request.additionalWrites![0].targets[0]!.transitions },
          { targetDocumentId: 'two', previousRevision: null, revision: 1, transitions: secondTarget.transitions }
        ]
      });
      expect(result).toMatchObject({ additionalWrites: [record] });
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ state: { value: 1, kept: 'yes' }, revision: 1, sourceProgress: { [sourceKey]: 0 } }],
        links: [{ revision: 1, targetDocumentId: 'one' }]
      });
    });

    test('a re-reduced own-record delivery returns the canonical durable group', async () => {
      const { store, records } = create();
      const first: Request = { ...projectionChangesRequest(), progress: {
        strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 }
      } };
      const committed = await store.commitProjectionSourceCommit(first);
      expect(committed.status).toBe('committed');
      const reReduced: Request = { ...projectionChangesRequest(1), commit: first.commit, progress: first.progress,
        additionalWrites: [{ ...first.additionalWrites![0], targets: [{
          targetDocumentId: 'one', transitions: [{ eventId: first.commit.events[0].eventId,
            eventIndex: 0, changeType: 'update', patch: [{ op: 'replace', path: '/value', value: 2 }] }]
        }] }] };
      expect(await store.commitProjectionSourceCommit(reReduced)).toEqual(committed);
      expect(await store.commitProjectionSourceCommit({ ...first, commit: { ...first.commit, commitId: 'different' } }))
        .toMatchObject({ status: 'rejected', category: 'terminal' });
      const changeIdentity = { sourceId, commitId: first.commit.commitId, commitSequence: 0, collection: 'order_views' };
      expect(await store.loadProjectionSourceCommitSnapshot({ ...changeSnapshotRequest, changeIdentity }))
        .toMatchObject({ changeReceipt: 'committed' });
      expect(await store.loadProjectionSourceCommitSnapshot({
        ...changeSnapshotRequest, changeIdentity: { ...changeIdentity, collection: 'different' }
      })).toMatchObject({ changeReceipt: 'mismatch' });
      expect(records()).toHaveLength(1);
      expect((await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).targets[0]).toMatchObject({
        revision: 1, state: { value: 1, kept: 'yes' }
      });
    });

    test('none applications of the same source turn append distinct revision-fenced histories', async () => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      expect(await store.commitProjectionSourceCommit(first)).toMatchObject({ status: 'rejected', category: 'conflict' });
      const second = projectionChangesRequest(1);
      const repeated: Request = { ...second, commit: first.commit, additionalWrites: [{
        ...second.additionalWrites![0], targets: [{ targetDocumentId: 'one', transitions: [{
          eventId: first.commit.events[0].eventId, eventIndex: 0, changeType: 'update',
          patch: [{ op: 'replace', path: '/value', value: 2 }]
        }] }]
      }] };
      expect((await store.commitProjectionSourceCommit(repeated)).status).toBe('committed');
      expect(new Set(records().map((record) => record.applicationId)).size).toBe(2);
      expect(new Set(records().map((record) => record.resumeToken)).size).toBe(2);
      expect(records().map((record) => record.targets[0]?.revision)).toEqual([1, 2]);
    });

    test('rejects mismatched patches and stale link fences without appending or advancing own progress', async () => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      const own: Request['progress'] = { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 } };
      expect(await store.commitProjectionSourceCommit({
        ...first, progress: own, finalDocuments: [{ ...first.finalDocuments[0]!, finalDocument: { value: 99 } }]
      })).toMatchObject({ status: 'rejected', category: 'terminal' });
      expect(await store.commitProjectionSourceCommit({
        ...first, progress: own, stagedLinks: [{ ...first.stagedLinks[0]!, expectedRevision: 1 }]
      })).toMatchObject({ status: 'rejected', category: 'conflict' });
      expect(records()).toEqual([]);
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ revision: null, state: null }], links: [{ revision: null }], ownRecordSequence: null
      });
      expect(await store.commitProjectionSourceCommit({ ...first, progress: own })).toMatchObject({ status: 'committed' });
      expect((await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).ownRecordSequence).toBe(0);
    });

    test('keeps generation identities separate and does not append for opt-out or empty commits', async () => {
      const { store, records } = create();
      const { additionalWrites, ...first } = projectionChangesRequest();
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      const empty: Request = { ...first, projectionGeneration: 'empty', finalDocuments: [], stagedLinks: [],
        progress: { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 } },
        additionalWrites: [{ ...additionalWrites![0], targets: [] }] };
      const emptyResult = await store.commitProjectionSourceCommit(empty);
      expect(emptyResult).toMatchObject({ status: 'committed', emptyChangeReceipt: { kind: 'projection_changes_empty' } });
      expect(await store.commitProjectionSourceCommit(empty)).toEqual(emptyResult);
      expect(records()).toEqual([]);
      const other = { ...first.finalDocuments[0]!, targetDocumentId: 'two' };
      const append = additionalWrites![0];
      const request: Request = {
        ...first, projectionGeneration: 'g2', finalDocuments: [other], stagedLinks: [],
        additionalWrites: [{ ...append, targets: [{ ...append.targets[0]!, targetDocumentId: 'two' }] }]
      };
      expect((await store.commitProjectionSourceCommit(request)).status).toBe('committed');
      expect(projectionChangesResumeToken(request)).not.toBe(projectionChangesResumeToken(first));
      expect(records()).toEqual([expect.objectContaining({ projectionGeneration: 'g2' })]);
    });

    test('rejects DBRef-shaped JSON in both adapters before any mutation', async () => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      const append = first.additionalWrites![0];
      const target = append.targets[0]!;
      const finalDocument = { value: 1, kept: 'yes', reference: { $ref: 'links', $id: 'id' } };
      const request: Request = {
        ...first,
        progress: { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 } },
        finalDocuments: [{ ...first.finalDocuments[0]!, finalDocument }],
        additionalWrites: [{ ...append, targets: [{ ...target, transitions: [{
          ...target.transitions[0]!, patch: [{ op: 'add', path: '', value: finalDocument }]
        }] }] }]
      };
      expect(await store.commitProjectionSourceCommit(request)).toMatchObject({
        status: 'rejected', category: 'terminal', reason: expect.stringContaining('portable JSON')
      });
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ revision: null, state: null }], links: [{ revision: null }], ownRecordSequence: null
      });
      expect(records()).toEqual([]);
    });

    test.each([false, true])('rejects negative zero in recorded state, already stored=%s', async (alreadyStored) => {
      const { store, records } = create();
      const { additionalWrites: _seedAppend, ...seed } = projectionChangesRequest();
      const initial = { value: alreadyStored ? -0 : +0 };
      expect(await store.commitProjectionSourceCommit({
        ...seed, finalDocuments: [{ ...seed.finalDocuments[0]!, finalDocument: initial }],
        progress: { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 } }
      })).toMatchObject({ status: 'committed' });
      const next = projectionChangesRequest(1);
      const append = next.additionalWrites![0];
      const target = append.targets[0]!;
      const transitions = [{ ...target.transitions[0]!, changeType: 'noop' as const, patch: [] }];
      const before = await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest);
      expect(await store.commitProjectionSourceCommit({
        ...next, finalDocuments: [{ ...next.finalDocuments[0]!, finalDocument: { value: -0 },
          statePatch: { kind: 'ordered', transitions } }],
        progress: { strategy: 'own_record', source: { sourceId, expectedSequence: 0, finalSequence: 1 } },
        additionalWrites: [{ ...append, targets: [{ ...target, transitions }] }]
      })).toMatchObject({ status: 'rejected', category: 'terminal', reason: expect.stringContaining('projection change') });
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toEqual(before);
      expect(records()).toEqual([]);
    });

    test('rejects an opted-in turn whose own-record marker exists but whose receipt does not', async () => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      const progress = { strategy: 'own_record' as const, source: { sourceId, expectedSequence: null, finalSequence: 0 } };
      const { additionalWrites, ...oldRequest } = first;
      expect((await store.commitProjectionSourceCommit({ ...oldRequest, progress })).status).toBe('committed');
      expect(await store.commitProjectionSourceCommit({ ...first, progress })).toMatchObject({
        status: 'rejected', category: 'terminal', reason: expect.stringMatching(/Missing projection_changes history/)
      });
      expect(records()).toEqual([]);
    });
  });
}
