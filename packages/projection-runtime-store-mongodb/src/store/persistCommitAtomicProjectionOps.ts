import type { AnyBulkWriteOperation, BulkWriteOptions, ClientSession } from 'mongodb';
import type { ProjectionDocumentRecord } from '../types';
import type { CommitAtomicWrite } from './persistCommitAtomicTypes';

const withSession = <T extends object>(options: T, session: ClientSession): T & { session: ClientSession } => ({
  ...options,
  session
});

const buildProjectionOps = <TState>(
  write: CommitAtomicWrite<TState>,
  now: () => string
): Array<AnyBulkWriteOperation<ProjectionDocumentRecord<TState>>> => {
  const ops = write.documents.map((document) => ({
    updateOne: {
      filter: { _id: document.documentId },
      update: {
        $set: {
          state: document.state,
          checkpoint: document.checkpoint,
          updatedAt: now()
        }
      },
      upsert: true
    }
  }));

  ops.push({
    updateOne: {
      filter: { _id: write.cursorKey },
      update: {
        $set: {
          state: {} as TState,
          checkpoint: write.cursor,
          updatedAt: now()
        }
      },
      upsert: true
    }
  });

  return ops;
};

export const persistCommitAtomicProjectionOps = async <TState>(
  write: CommitAtomicWrite<TState>,
  session: ClientSession,
  collection: { bulkWrite: (...args: unknown[]) => Promise<unknown> },
  now: () => string
): Promise<void> => {
  const projectionOps = buildProjectionOps(write, now);
  if (projectionOps.length === 0) {
    return;
  }

  await collection.bulkWrite(projectionOps, withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session));
};
