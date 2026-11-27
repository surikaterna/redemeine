import { joinMembershipKey, type CommitProjectionSourceCommitCommitted,
  type CommitProjectionSourceCommitRequest } from '@redemeine/projection-runtime-core';
import type { LoadedSourceSnapshot } from './sourceCommitSnapshot';

/** A sequence or even identical state can belong to a different writer. The own-progress
 * write ID is an atomic witness; check the intended revisions/sets in the same snapshot. */
export function reconcileSetSourceCommit<T>(request: CommitProjectionSourceCommitRequest<T>, writeId: string,
  loaded: LoadedSourceSnapshot<T>): CommitProjectionSourceCommitCommitted | undefined {
  const { progress, joinMembershipFences } = request;
  if (!joinMembershipFences || progress.strategy !== 'own_record' || loaded.ownWriteId !== writeId
    || loaded.snapshot.ownRecordSequence !== progress.source.finalSequence) return undefined;

  const documents = new Map<string, number>();
  for (const doc of request.finalDocuments) {
    const row = loaded.rows.get(doc.targetDocumentId);
    const revision = (doc.expectedRevision ?? 0) + 1;
    if (row?.v2WriteId !== writeId || row.v2Revision !== revision) return undefined;
    documents.set(doc.targetDocumentId, revision);
  }

  const rows = new Map(loaded.snapshot.joinMemberships?.map((row) =>
    [joinMembershipKey(row.aggregateType, row.aggregateId), row]));
  const links = new Map<string, number>();
  for (const fence of joinMembershipFences) {
    const key = joinMembershipKey(fence.aggregateType, fence.aggregateId);
    const row = rows.get(key);
    const revision = (fence.expectedRevision ?? 0) + 1;
    if (row?.revision !== revision || row.targetDocumentIds.length !== fence.targetDocumentIds.length
      || !fence.targetDocumentIds.every((id, index) => id === row.targetDocumentIds[index])) return undefined;
    links.set(key, revision);
  }

  return { version: 1, status: 'committed', commitSequence: request.commit.commitSequence, progress,
    documentRevisions: Object.fromEntries(documents), linkRevisions: Object.fromEntries(links) };
}
