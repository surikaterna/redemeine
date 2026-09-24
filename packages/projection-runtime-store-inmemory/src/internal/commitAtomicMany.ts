import type {
  Checkpoint,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreDocumentWrite
} from '@redemeine/projection-runtime-core';
import { chooseHigherWatermark, cloneCheckpoint } from './checkpoints';
import { assertPrecondition, createFailure, createInvalidRequestFailure, ProjectionStoreAtomicManyError } from './failures';
import { validatePatchOperationStructure } from './rfc6902Validation';
import type { StoredDocument } from './storedDocument';

interface CommittedState<TState> {
  documents: Map<string, StoredDocument<TState>>;
  dedupe: Map<string, Checkpoint>;
}

interface Execution<TState> {
  result: ProjectionStoreAtomicManyResult;
  committedState?: CommittedState<TState>;
}

interface StagedState<TState> extends CommittedState<TState> {
  byLaneWatermark: Record<string, Checkpoint>;
  highestWatermark: Checkpoint | null;
}

const reject = (message: string, failedAtIndex = 0): Execution<never> => {
  const failure = createInvalidRequestFailure(message);
  return { result: { status: 'rejected', highestWatermark: null, failedAtIndex, failure, reason: failure.message, committedCount: 0 } };
};

const validateRequest = <TState>(request: ProjectionStoreCommitAtomicManyRequest<TState>): Execution<never> | null => {
  if (request.mode !== 'atomic-all') return reject(`unsupported mode: ${request.mode}`);
  if (request.writes.length === 0) return reject('no writes');
  const seen = new Set<string>();
  for (let index = 0; index < request.writes.length; index += 1) {
    for (const document of request.writes[index]!.documents) {
      if (seen.has(document.documentId)) {
        return reject(`duplicate document write in atomic-all batch: documentId='${document.documentId}'`, index);
      }
      seen.add(document.documentId);
    }
  }
  return null;
};

const applyDocument = <TState>(state: StagedState<TState>, write: ProjectionStoreDocumentWrite<TState>): void => {
  assertPrecondition(write.documentId, state.documents.get(write.documentId), write.precondition);
  if (write.mode === 'patch') {
    try {
      write.patch.forEach(validatePatchOperationStructure);
    } catch (error) {
      throw new ProjectionStoreAtomicManyError(createInvalidRequestFailure(error instanceof Error ? error.message : 'invalid patch request'));
    }
  }
  state.documents.set(write.documentId, {
    state: write.fullDocument,
    checkpoint: cloneCheckpoint(write.checkpoint),
    updatedAt: new Date().toISOString()
  });
};

const applyWrite = <TState>(state: StagedState<TState>, write: ProjectionStoreCommitAtomicManyRequest<TState>['writes'][number]): void => {
  let laneWatermark: Checkpoint | null = null;
  for (const document of write.documents) {
    applyDocument(state, document);
    laneWatermark = chooseHigherWatermark(laneWatermark, document.checkpoint);
    state.highestWatermark = chooseHigherWatermark(state.highestWatermark, document.checkpoint);
  }
  for (const dedupe of write.dedupe.upserts) {
    state.dedupe.set(dedupe.key, cloneCheckpoint(dedupe.checkpoint));
    laneWatermark = chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
    state.highestWatermark = chooseHigherWatermark(state.highestWatermark, dedupe.checkpoint);
  }
  if (laneWatermark) state.byLaneWatermark[write.routingKeySource] = laneWatermark;
};

const rejectedExecution = <TState>(error: unknown, failedAtIndex: number): Execution<TState> => {
  const failure =
    error instanceof ProjectionStoreAtomicManyError
      ? error.failure
      : createFailure('transient', 'write-failed', error instanceof Error ? error.message : 'atomicMany write failed');
  return { result: { status: 'rejected', highestWatermark: null, failedAtIndex, failure, reason: failure.message, committedCount: 0 } };
};

export const executeCommitAtomicMany = <TState>(
  request: ProjectionStoreCommitAtomicManyRequest<TState>,
  documents: ReadonlyMap<string, StoredDocument<TState>>,
  dedupe: ReadonlyMap<string, Checkpoint>
): Execution<TState> => {
  const invalid = validateRequest(request);
  if (invalid) return invalid;
  const state: StagedState<TState> = {
    documents: new Map(documents),
    dedupe: new Map(dedupe),
    byLaneWatermark: {},
    highestWatermark: null
  };
  for (let index = 0; index < request.writes.length; index += 1) {
    try {
      applyWrite(state, request.writes[index]!);
    } catch (error) {
      return rejectedExecution(error, index);
    }
  }
  return {
    result: {
      status: 'committed',
      highestWatermark: state.highestWatermark ?? { sequence: 0 },
      byLaneWatermark: state.byLaneWatermark,
      committedCount: request.writes.length
    },
    committedState: { documents: state.documents, dedupe: state.dedupe }
  };
};
