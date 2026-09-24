import type { ProjectionStoreWriteFailure, ProjectionStoreWritePrecondition } from '@redemeine/projection-runtime-core';
import { matchesCheckpoint } from './checkpoints';
import type { StoredDocument } from './storedDocument';

export class ProjectionStoreAtomicManyError extends Error {
  constructor(readonly failure: ProjectionStoreWriteFailure) {
    super(failure.message);
  }
}

export const createFailure = (category: ProjectionStoreWriteFailure['category'], code: string, message: string): ProjectionStoreWriteFailure => ({
  category,
  code,
  message,
  retryable: category !== 'terminal'
});

export const createInvalidRequestFailure = (message: string): ProjectionStoreWriteFailure => createFailure('terminal', 'invalid-request', message);

const createConflictFailure = (message: string): ProjectionStoreWriteFailure => createFailure('conflict', 'occ-conflict', message);

const assertRevision = (documentId: string, current: StoredDocument<unknown> | undefined, precondition: ProjectionStoreWritePrecondition): void => {
  if (!Object.prototype.hasOwnProperty.call(precondition, 'expectedRevision')) return;
  const actual = current?.checkpoint?.sequence ?? null;
  const expected = precondition.expectedRevision ?? null;
  if (actual === expected) return;
  throw new ProjectionStoreAtomicManyError(
    createConflictFailure(`OCC precondition failed for document '${documentId}': expectedRevision=${String(expected)}, actualRevision=${String(actual)}`)
  );
};

const assertCheckpoint = (documentId: string, current: StoredDocument<unknown> | undefined, precondition: ProjectionStoreWritePrecondition): void => {
  if (!Object.prototype.hasOwnProperty.call(precondition, 'expectedCheckpoint')) return;
  const actual = current?.checkpoint ?? null;
  const expected = precondition.expectedCheckpoint ?? null;
  const matches = actual && expected ? matchesCheckpoint(actual, expected) : actual === expected;
  if (matches) return;
  throw new ProjectionStoreAtomicManyError(
    createConflictFailure(
      `OCC precondition failed for document '${documentId}': expectedCheckpoint=${JSON.stringify(expected)}, actualCheckpoint=${JSON.stringify(actual)}`
    )
  );
};

export const assertPrecondition = (documentId: string, current: StoredDocument<unknown> | undefined, precondition?: ProjectionStoreWritePrecondition): void => {
  if (!precondition) return;
  assertRevision(documentId, current, precondition);
  assertCheckpoint(documentId, current, precondition);
};
