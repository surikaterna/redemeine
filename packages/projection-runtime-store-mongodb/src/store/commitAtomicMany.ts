import type { AnyBulkWriteOperation, BulkWriteOptions, ClientSession } from 'mongodb';
import type {
  Checkpoint,
  ProjectionStoreAtomicManyRejectedResult,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest
} from '../contracts';
import { assertWritePrecondition, createInvalidRequestFailure, toWriteFailure } from '../storeFailures';
import type { ProjectionDocumentRecord } from '../types';
import { withSession } from './withSession';

const cloneCheckpoint = (checkpoint: Checkpoint): Checkpoint => ({
  sequence: checkpoint.sequence,
  ...(checkpoint.timestamp ? { timestamp: checkpoint.timestamp } : {})
});

const chooseHigherWatermark = (current: Checkpoint | null, next: Checkpoint): Checkpoint => {
  if (!current || next.sequence > current.sequence) {
    return cloneCheckpoint(next);
  }

  if (next.sequence === current.sequence && next.timestamp && (!current.timestamp || next.timestamp > current.timestamp)) {
    return cloneCheckpoint(next);
  }

  return current;
};

const toRejected = (
  failure: ReturnType<typeof createInvalidRequestFailure>,
  failedAtIndex: number
): ProjectionStoreAtomicManyRejectedResult => ({
  status: 'rejected',
  highestWatermark: null,
  failedAtIndex,
  failure,
  reason: failure.message,
  committedCount: 0
});

const validateRequest = <TState>(
  request: ProjectionStoreCommitAtomicManyRequest<TState>
): ProjectionStoreAtomicManyRejectedResult | null => {
  if (request.mode !== 'atomic-all') {
    return toRejected(createInvalidRequestFailure(`unsupported mode: ${request.mode}`), 0);
  }

  if (request.writes.length === 0) {
    return toRejected(createInvalidRequestFailure('no writes'), 0);
  }

  return null;
};

const validateDuplicateDocuments = <TState>(
  request: ProjectionStoreCommitAtomicManyRequest<TState>
): ProjectionStoreAtomicManyRejectedResult | null => {
  const seen = new Set<string>();
  for (let index = 0; index < request.writes.length; index += 1) {
    for (const document of request.writes[index].documents) {
      if (seen.has(document.documentId)) {
        const failure = createInvalidRequestFailure(
          `duplicate document write in atomic-all batch: documentId='${document.documentId}'`
        );
        return toRejected(failure, index);
      }

      seen.add(document.documentId);
    }
  }

  return null;
};

type Watermarks = {
  byLaneWatermark: Record<string, Checkpoint>;
  highestWatermark: Checkpoint | null;
  failedAtIndex: number;
};

type CommitAtomicManyDependencies<TState> = {
  execute: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  request: ProjectionStoreCommitAtomicManyRequest<TState>;
  collection: { findOne: (filter: { _id: string }, options?: { session: ClientSession }) => Promise<{ checkpoint?: Checkpoint } | null>; bulkWrite: (...args: unknown[]) => Promise<unknown> };
  dedupeCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> };
  now: () => string;
  buildDocumentWriteOperation: (
    write: ProjectionStoreCommitAtomicManyRequest<TState>['writes'][number]['documents'][number]
  ) => AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>;
};

const applyWrite = async <TState>(
  deps: CommitAtomicManyDependencies<TState>,
  session: ClientSession,
  write: ProjectionStoreCommitAtomicManyRequest<TState>['writes'][number],
  watermarks: Watermarks
): Promise<void> => {
  let laneWatermark: Checkpoint | null = null;
  const documentOps: Array<AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>> = [];

  for (const document of write.documents) {
    if (document.precondition) {
      const current = await deps.collection.findOne({ _id: document.documentId }, withSession({}, session));
      assertWritePrecondition(document.documentId, current?.checkpoint ?? null, document.precondition);
    }

    documentOps.push(deps.buildDocumentWriteOperation(document));
    laneWatermark = chooseHigherWatermark(laneWatermark, document.checkpoint);
    watermarks.highestWatermark = chooseHigherWatermark(watermarks.highestWatermark, document.checkpoint);
  }

  if (documentOps.length > 0) {
    await deps.collection.bulkWrite(documentOps, withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: false }, session));
  }

  if (write.dedupe.upserts.length > 0) {
    await deps.dedupeCollection.bulkWrite(
      write.dedupe.upserts.map((dedupe) => ({
        updateOne: { filter: { _id: dedupe.key }, update: { $set: { checkpoint: dedupe.checkpoint, updatedAt: deps.now() } }, upsert: true }
      })),
      withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: false }, session)
    );

    for (const dedupe of write.dedupe.upserts) {
      laneWatermark = chooseHigherWatermark(laneWatermark, dedupe.checkpoint);
      watermarks.highestWatermark = chooseHigherWatermark(watermarks.highestWatermark, dedupe.checkpoint);
    }
  }

  if (laneWatermark) {
    watermarks.byLaneWatermark[write.routingKeySource] = laneWatermark;
  }
};

const executeWrites = async <TState>(deps: CommitAtomicManyDependencies<TState>, watermarks: Watermarks): Promise<void> => {
  await deps.execute(async (session) => {
    for (let index = 0; index < deps.request.writes.length; index += 1) {
      watermarks.failedAtIndex = index;
      await applyWrite(deps, session, deps.request.writes[index], watermarks);
    }
  });
};

export const commitAtomicMany = async <TState>(
  deps: CommitAtomicManyDependencies<TState>
): Promise<ProjectionStoreAtomicManyResult> => {
  const invalidRequest = validateRequest(deps.request) ?? validateDuplicateDocuments(deps.request);
  if (invalidRequest) {
    return invalidRequest;
  }

  const watermarks: Watermarks = { byLaneWatermark: {}, highestWatermark: null, failedAtIndex: 0 };
  try {
    await executeWrites(deps, watermarks);
  } catch (error) {
    const failure = toWriteFailure(error);
    return {
      status: 'rejected',
      highestWatermark: null,
      failedAtIndex: watermarks.failedAtIndex,
      failure,
      reason: failure.message,
      committedCount: 0
    };
  }

  return {
    status: 'committed',
    highestWatermark: watermarks.highestWatermark ?? { sequence: 0 },
    byLaneWatermark: watermarks.byLaneWatermark,
    committedCount: deps.request.writes.length
  };
};
