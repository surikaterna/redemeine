import {
  projectionChangesResumeToken,
  projectionUuidToBase64Url22,
  type CommitProjectionSourceCommitRequest,
  type ProjectionChangesRecord,
  type ProjectionSourceCommitStorePort
} from '../src';
import {
  invalidChangeMetadataRequests, serializerLikeTargetIds, withSerializerLikeTargetIds, withUnicodeChangeMetadata
} from './projectionChangeMetadataFixtures';

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
    test.each(invalidChangeMetadataRequests(projectionChangesRequest()))('rejects %s before writing', async (_name, request) => {
      const { store, records } = create();
      expect(await store.commitProjectionSourceCommit(request)).toMatchObject({
        status: 'rejected', category: 'terminal', retryable: false, reason: expect.stringMatching(/metadata|keys collide/)
      });
      expect(records()).toEqual([]);
      expect(await store.loadProjectionSourceCommitSnapshot(changeSnapshotRequest)).toMatchObject({
        targets: [{ state: null, revision: null }], links: [{ revision: null }], ownRecordSequence: null
      });
    });

    test('Unicode names and dynamic revision keys survive canonical receipt replay', async () => {
      const { store, records } = create();
      const request = withUnicodeChangeMetadata({ ...projectionChangesRequest(), progress: {
        strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 }
      } });
      const result = await store.commitProjectionSourceCommit(request);
      expect(result).toMatchObject({ status: 'committed', documentRevisions: { 'ticket_🎫_cafe\u0301': 1 }, linkRevisions: { '注文:関連🌐': 1 } });
      expect(await store.commitProjectionSourceCommit(request)).toEqual(result);
      expect(records()).toMatchObject([{ projectionName: '注文📦', projectionGeneration: 'génération', collection: 'order_🧾_e\u0301' }]);
    });

    test('serializer and prototype names remain ordinary target IDs and own revision keys through replay', async () => {
      const { store, records } = create();
      const request = withSerializerLikeTargetIds(projectionChangesRequest());
      const first = await store.commitProjectionSourceCommit(request);
      const replay = await store.commitProjectionSourceCommit(request);
      expect(first).toMatchObject({ status: 'committed' });
      expect(replay).toEqual(first);
      for (const result of [first, replay]) {
        if (result.status !== 'committed') throw new Error('expected a committed receipt');
        expect(Object.keys(result.documentRevisions)).toEqual(serializerLikeTargetIds);
        for (const id of serializerLikeTargetIds) expect(Object.getOwnPropertyDescriptor(result.documentRevisions, id)?.value).toBe(1);
        expect(Object.getPrototypeOf(result.documentRevisions)?.constructor.name).toBe('Object');
      }
      expect(records()).toHaveLength(1);
      expect(records()[0]?.targets.map((target) => target.targetDocumentId)).toEqual(serializerLikeTargetIds);
      const snapshot = await store.loadProjectionSourceCommitSnapshot({
        ...changeSnapshotRequest, projectionGeneration: request.projectionGeneration, targetDocumentIds: serializerLikeTargetIds
      });
      expect(snapshot.targets).toEqual(serializerLikeTargetIds.map((targetDocumentId) => ({
        targetDocumentId, state: { value: 1, kept: 'yes' }, revision: 1, sourceProgress: {}
      })));
    });

    test('serializer-like target IDs remain valid without a change receipt', async () => {
      const { store, records } = create();
      const { additionalWrites, ...request } = withSerializerLikeTargetIds(projectionChangesRequest());
      const result = await store.commitProjectionSourceCommit(request);
      expect(result).toMatchObject({ status: 'committed' });
      if (result.status !== 'committed') return;
      expect(result.documentRevisions._bsontype).toBe(1);
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

    test.each([
      { $ref: 'links', $id: 'id' },
      { _bsontype: 'ObjectId' },
      { ['key\0']: 'value' },
      { surrogate: '\ud800' }
    ])('rejects non-portable nested JSON before any mutation: %j', async (reference) => {
      const { store, records } = create();
      const first = projectionChangesRequest();
      const append = first.additionalWrites![0];
      const target = append.targets[0]!;
      const finalDocument = { value: 1, kept: 'yes', reference: [reference] };
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
      expect((await store.commitProjectionSourceCommit(first)).status).toBe('committed');
      expect((await store.commitProjectionSourceCommit(projectionChangesRequest(1))).status).toBe('committed');
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
