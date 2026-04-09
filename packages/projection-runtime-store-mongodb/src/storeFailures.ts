import type {
  Checkpoint,
  ProjectionStoreWriteFailure,
  ProjectionStoreWritePrecondition
} from './contracts';

export class ProjectionStoreAtomicManyError extends Error {
  constructor(readonly failure: ProjectionStoreWriteFailure) {
    super(failure.message);
  }
}

export const createStoreFailure = (
  category: ProjectionStoreWriteFailure['category'],
  code: string,
  message: string
): ProjectionStoreWriteFailure => ({
  category,
  code,
  message,
  retryable: category !== 'terminal'
});

export const createInvalidRequestFailure = (message: string): ProjectionStoreWriteFailure =>
  createStoreFailure('terminal', 'invalid-request', message);

export const toWriteFailure = (error: unknown): ProjectionStoreWriteFailure => {
  if (error instanceof ProjectionStoreAtomicManyError) {
    return error.failure;
  }

  return createStoreFailure(
    'transient',
    'write-failed',
    error instanceof Error ? error.message : 'atomicMany write failed'
  );
};

const matchesCheckpoint = (left: Checkpoint, right: Checkpoint): boolean => {
  return left.sequence === right.sequence && (left.timestamp ?? null) === (right.timestamp ?? null);
};

export const assertWritePrecondition = (
  documentId: string,
  actualCheckpoint: Checkpoint | null,
  precondition?: ProjectionStoreWritePrecondition
): void => {
  if (!precondition) {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(precondition, 'expectedRevision')) {
    const actualRevision = actualCheckpoint?.sequence ?? null;
    const expectedRevision = precondition.expectedRevision ?? null;

    if (actualRevision !== expectedRevision) {
      throw new ProjectionStoreAtomicManyError(
        createStoreFailure(
          'conflict',
          'occ-conflict',
          `OCC precondition failed for document '${documentId}': expectedRevision=${String(expectedRevision)}, actualRevision=${String(actualRevision)}`
        )
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(precondition, 'expectedCheckpoint')) {
    const expectedCheckpoint = precondition.expectedCheckpoint ?? null;
    const matches = actualCheckpoint !== null && expectedCheckpoint !== null
      ? matchesCheckpoint(actualCheckpoint, expectedCheckpoint)
      : actualCheckpoint === expectedCheckpoint;

    if (!matches) {
      throw new ProjectionStoreAtomicManyError(
        createStoreFailure(
          'conflict',
          'occ-conflict',
          `OCC precondition failed for document '${documentId}': expectedCheckpoint=${JSON.stringify(expectedCheckpoint)}, actualCheckpoint=${JSON.stringify(actualCheckpoint)}`
        )
      );
    }
  }
};
