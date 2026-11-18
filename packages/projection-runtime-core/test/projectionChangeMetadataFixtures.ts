import { projectionUuidToBase64Url22, type CommitProjectionSourceCommitRequest } from '../src';

type Request = CommitProjectionSourceCommitRequest;

export function withTarget<T>(request: CommitProjectionSourceCommitRequest<T>, targetDocumentId: string): CommitProjectionSourceCommitRequest<T> {
  const append = request.additionalWrites![0];
  return {
    ...request,
    finalDocuments: request.finalDocuments.map((target) => ({ ...target, targetDocumentId })),
    stagedLinks: request.stagedLinks.map((link) => ({ ...link, targetDocumentId })),
    additionalWrites: [{ ...append, targets: append.targets.map((target) => ({ ...target, targetDocumentId })) }]
  };
}

export const serializerLikeTargetIds = ['_bsontype', 'toBSON', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'] as const;

export function withSerializerLikeTargetIds<T>(
  request: CommitProjectionSourceCommitRequest<T>, ids: readonly string[] = serializerLikeTargetIds
): CommitProjectionSourceCommitRequest<T> {
  const variants = ids.map((targetId) => withTarget(request, targetId));
  const { streamId, commitSequence } = request.commit;
  return {
    ...request, projectionGeneration: 'serializer-keys',
    progress: { strategy: 'own_record', source: { sourceId: streamId, expectedSequence: null, finalSequence: commitSequence } },
    finalDocuments: variants.flatMap((variant) => variant.finalDocuments),
    stagedLinks: [],
    additionalWrites: [{ ...request.additionalWrites![0], targets: variants.flatMap((variant) => variant.additionalWrites![0].targets) }]
  };
}

export function withUnicodeChangeMetadata<T>(request: CommitProjectionSourceCommitRequest<T>): CommitProjectionSourceCommitRequest<T> {
  const base = withTarget(request, 'ticket_🎫_cafe\u0301');
  return {
    ...base, projectionName: '注文📦', projectionGeneration: 'génération',
    stagedLinks: [{ operation: 'subscribe', aggregateType: '注文', aggregateId: '関連🌐', targetDocumentId: 'ticket_🎫_cafe\u0301', expectedRevision: null }],
    additionalWrites: [{ ...base.additionalWrites![0], collection: 'order_🧾_e\u0301' }]
  };
}

export function invalidChangeMetadataRequests<T>(
  first: CommitProjectionSourceCommitRequest<T>
): readonly (readonly [name: string, request: CommitProjectionSourceCommitRequest<T>])[] {
  const append = first.additionalWrites![0];
  const target = append.targets[0]!;
  const eventId = 'event_\ud800';
  const { streamId, commitSequence } = first.commit;
  const key = projectionUuidToBase64Url22(streamId);
  const badFinal = { [key]: commitSequence, ['bad\0key']: 1 };
  const links = [
    { operation: 'subscribe' as const, targetDocumentId: target.targetDocumentId, aggregateType: 'A:B', aggregateId: 'C', expectedRevision: null },
    { operation: 'subscribe' as const, targetDocumentId: target.targetDocumentId, aggregateType: 'A', aggregateId: 'B:C', expectedRevision: null }
  ];
  return [
    ['collection surrogate', { ...first, additionalWrites: [{ ...append, collection: 'order_\ud800' }] }],
    ['target NUL', withTarget(first, 'order\0two')],
    ['projection name NUL', { ...first, projectionName: `${first.projectionName}\0` }],
    ['generation surrogate', { ...first, projectionGeneration: 'g\udc00' }],
    ['commit ID surrogate', { ...first, commit: { ...first.commit, commitId: 'commit_\ud800' } }],
    ['event ID surrogate', { ...first, commit: { ...first.commit, events: [{ ...first.commit.events[0], eventId }] },
      additionalWrites: [{ ...append, targets: [{ ...target, transitions: [{ ...target.transitions[0]!, eventId }] }] }] }],
    ['link aggregate NUL', { ...first, stagedLinks: [{ ...links[0]!, aggregateId: 'link\0id' }] }],
    ['colliding link revision keys', { ...first, stagedLinks: links }],
    ['dynamic progress key NUL', { ...first, progress: { strategy: 'in_document',
      targets: [{ targetDocumentId: target.targetDocumentId, expected: {}, final: badFinal }] } }]
  ] satisfies readonly (readonly [string, Request])[];
}
