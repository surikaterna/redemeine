import { isPortableProjectionChangeJson, isPortableProjectionChangeKey } from './projectionChangeJson';
import type { ProjectionChangesAppend, ProjectionChangesSourceIdentity } from './projectionChanges';
import type { CommitProjectionSourceCommitRequest } from './sourceCommitStore';
import { isCanonicalProjectionUuid } from './sourceCommit';

function isPortableString(value: unknown): value is string {
  return typeof value === 'string' && isPortableProjectionChangeKey(value);
}

function isRequiredIdentifier(value: unknown): value is string {
  return isPortableString(value) && value.length > 0;
}

export function validateProjectionChangeIdentityMetadata(
  identity: ProjectionChangesSourceIdentity & { projectionName: string; projectionGeneration: string }
): string | null {
  const { projectionName, projectionGeneration, collection, sourceId, commitId, commitSequence } = identity;
  if (![projectionName, projectionGeneration, collection, commitId].every(isPortableString)) {
    return 'projection_changes identity metadata must use well-formed strings without NUL';
  }
  if (!isCanonicalProjectionUuid(sourceId) || !Number.isSafeInteger(commitSequence) || commitSequence < 0) {
    return 'invalid projection change source position';
  }
  return null;
}

function isWritableRevision(revision: number | null): boolean {
  return revision === null || (Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER);
}

export function validateProjectionChangeWriteMetadata(
  request: CommitProjectionSourceCommitRequest,
  append: ProjectionChangesAppend
): string | null {
  const documentMetadataInvalid = request.finalDocuments.some(({ targetDocumentId, expectedRevision, legacyOriginal }) =>
    !isRequiredIdentifier(targetDocumentId) || !isWritableRevision(expectedRevision)
    || (legacyOriginal?.updatedAt !== undefined && !isPortableString(legacyOriginal.updatedAt))
    || (legacyOriginal?.checkpoint !== undefined && !isPortableProjectionChangeJson(legacyOriginal.checkpoint)));
  if (documentMetadataInvalid) return 'projection_changes document metadata is not portable';
  if (request.stagedLinks.some(({ targetDocumentId, aggregateType, aggregateId, expectedRevision }) =>
    ![targetDocumentId, aggregateType, aggregateId].every(isRequiredIdentifier) || !isWritableRevision(expectedRevision))) {
    return 'projection_changes link metadata is not portable';
  }
  const linkKeys = request.stagedLinks.map(({ aggregateType, aggregateId }) => `${aggregateType}:${aggregateId}`);
  if (new Set(linkKeys).size !== linkKeys.length) return 'projection_changes link revision keys collide';
  if (!isPortableProjectionChangeJson(request.progress)) return 'projection_changes progress metadata is not portable';
  if (append.targets.some((target) => target.transitions.some((transition) => !isRequiredIdentifier(transition.eventId)))) {
    return 'projection_changes event identity metadata is not portable';
  }
  return null;
}
