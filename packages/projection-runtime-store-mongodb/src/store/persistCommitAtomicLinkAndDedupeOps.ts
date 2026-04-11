import type { AnyBulkWriteOperation, BulkWriteOptions, ClientSession } from 'mongodb';
import type { ProjectionDedupeRecord, ProjectionLinkRecord } from '../types';
import type { CommitAtomicWrite } from './persistCommitAtomicTypes';

const withSession = <T extends object>(options: T, session: ClientSession): T & { session: ClientSession } => ({
  ...options,
  session
});

const persistLinks = async (
  write: CommitAtomicWrite<unknown>,
  session: ClientSession,
  linkCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> },
  now: () => string
): Promise<void> => {
  if (write.links.length === 0) {
    return;
  }

  await linkCollection.bulkWrite(
    write.links.map<AnyBulkWriteOperation<ProjectionLinkRecord>>((link) => ({
      updateOne: {
        filter: { _id: `${link.aggregateType}:${link.aggregateId}` },
        update: {
          $setOnInsert: {
            aggregateType: link.aggregateType,
            aggregateId: link.aggregateId,
            targetDocId: link.targetDocId,
            createdAt: now()
          }
        },
        upsert: true
      }
    })),
    withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
  );
};

const persistDedupe = async (
  write: CommitAtomicWrite<unknown>,
  session: ClientSession,
  dedupeCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> },
  now: () => string
): Promise<void> => {
  if (write.dedupe.upserts.length === 0) {
    return;
  }

  await dedupeCollection.bulkWrite(
    write.dedupe.upserts.map<AnyBulkWriteOperation<ProjectionDedupeRecord>>((dedupe) => ({
      updateOne: {
        filter: { _id: dedupe.key },
        update: {
          $set: {
            checkpoint: dedupe.checkpoint,
            updatedAt: now()
          }
        },
        upsert: true
      }
    })),
    withSession<Pick<BulkWriteOptions, 'ordered'>>({ ordered: true }, session)
  );
};

export const persistCommitAtomicLinkAndDedupeOps = async (
  write: CommitAtomicWrite<unknown>,
  session: ClientSession,
  deps: {
    linkCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> };
    dedupeCollection: { bulkWrite: (...args: unknown[]) => Promise<unknown> };
  },
  now: () => string
): Promise<void> => {
  await persistLinks(write, session, deps.linkCollection, now);
  await persistDedupe(write, session, deps.dedupeCollection, now);
};
