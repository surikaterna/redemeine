import {
  assertJoinRevision, chargeJoinMembershipSnapshotTargets, checkedJoinMembershipKey, freezeJoinSeedEdges, JoinTurnBudget, joinMembershipKey, JOIN_MEMBERSHIP_FORMAT,
  measureJoinTargetSet, ProjectionJoinMembershipValidationError, ProjectionPersistedJoinMembershipError, validateJoinMembershipSeeds,
  type CommitProjectionSourceCommitRequest, type LoadProjectionSourceCommitSnapshotRequest, type ProjectionJoinSource
} from '@redemeine/projection-runtime-core';
import type { AnyBulkWriteOperation, ClientSession, FindOptions } from 'mongodb';
import type { MongoProjectionStoreOptions, ProjectionJoinMembershipRecord } from '../types';

type Scope = Pick<LoadProjectionSourceCommitSnapshotRequest, 'projectionName' | 'projectionGeneration'>;
export const setIdentityCollation = { locale: 'simple' } as const;
const scopedKey = (scope: Scope, source: ProjectionJoinSource) =>
  checkedJoinMembershipKey(scope.projectionName, scope.projectionGeneration, source.aggregateType, source.aggregateId);

// The driver's bulk writer additionally splits by BSON size. Bound find filters independently of cursor batches.
export function* sourceCommitChunks<T>(items: readonly T[], size = 256): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
}

export function checkedSourceCommitIds<T>(items: readonly T[], idOf: (item: T) => string): string[] {
  const budget = new JoinTurnBudget();
  return items.map((item) => {
    const id = idOf(item);
    budget.add(id);
    return id;
  });
}

function measurePersistedTargets(row: ProjectionJoinMembershipRecord, source: ProjectionJoinSource | undefined, seedVersion?: 1): number {
  if (!source || row.format !== JOIN_MEMBERSHIP_FORMAT || row.aggregateType !== source.aggregateType
    || row.aggregateId !== source.aggregateId || row.revision === null || Object.keys(row).length !== (row.seeds ? 7 : 6)
    || (row.seeds && seedVersion !== 1)) {
    throw new ProjectionPersistedJoinMembershipError('Invalid joined membership row.');
  }
  try {
    assertJoinRevision(row.revision);
    const bytes = measureJoinTargetSet(row.targetDocumentIds);
    validateJoinMembershipSeeds(row);
    return bytes;
  } catch (error) {
    if (!(error instanceof ProjectionJoinMembershipValidationError)) throw error;
    throw new ProjectionPersistedJoinMembershipError(error.message, { cause: error });
  }
}

export async function readMongoMemberships<T>(
  request: LoadProjectionSourceCommitSnapshotRequest, options: MongoProjectionStoreOptions<T>, readOptions?: FindOptions
) {
  const collection = options.joinMembershipCollection;
  if (!collection) throw new Error('Join membership collection is not configured.');
  const ids = checkedSourceCommitIds(request.links, (source) => scopedKey(request, source));
  const expected = new Map(ids.map((id, index) => [id, request.links[index]!]));
  const rows = new Map<string, ProjectionJoinMembershipRecord>();
  const resultsBudget = new JoinTurnBudget();
  for (const chunk of sourceCommitChunks(ids)) {
    for await (const row of collection.find({ _id: { $in: chunk } }, { ...readOptions, collation: setIdentityCollation })) {
      const bytes = measurePersistedTargets(row, expected.get(row._id), request.joinSeedVersion);
      chargeJoinMembershipSnapshotTargets(resultsBudget, row.targetDocumentIds.length, bytes);
      rows.set(row._id, row);
    }
  }
  return request.links.map((source, index) => {
    const row = rows.get(ids[index]!);
    if (!row) return { ...source, revision: null, targetDocumentIds: [] };
    return { ...source, revision: row.revision, targetDocumentIds: Object.freeze([...row.targetDocumentIds]),
      ...(row.seeds ? { seeds: freezeJoinSeedEdges(row.seeds) } : {}) };
  });
}

export async function writeMongoMemberships<T>(
  request: CommitProjectionSourceCommitRequest<T>, options: MongoProjectionStoreOptions<T>, session: ClientSession
): Promise<Record<string, number>> {
  const collection = options.joinMembershipCollection;
  if (!collection) throw new Error('Join membership collection is not configured.');
  const inserts: AnyBulkWriteOperation<ProjectionJoinMembershipRecord>[] = [];
  const updates: AnyBulkWriteOperation<ProjectionJoinMembershipRecord>[] = [];
  const revisions = new Map<string, number>();
  for (const { aggregateType, aggregateId, expectedRevision, targetDocumentIds, seeds } of request.joinMembershipFences ?? []) {
    const source = { aggregateType, aggregateId };
    const _id = scopedKey(request, source);
    const revision = (expectedRevision ?? 0) + 1;
    if (expectedRevision === null) {
      inserts.push({ insertOne: { document: { _id, ...source, format: JOIN_MEMBERSHIP_FORMAT, revision, targetDocumentIds,
        ...(seeds ? { seeds } : {}) } } });
    } else {
      updates.push({ updateOne: { filter: { _id, format: JOIN_MEMBERSHIP_FORMAT, revision: expectedRevision,
        ...(request.joinSeedVersion ? {} : { seeds: { $exists: false } }) }, collation: setIdentityCollation,
        update: { $set: { revision, targetDocumentIds, ...(seeds ? { seeds } : {}) },
          ...(request.joinSeedVersion && !seeds ? { $unset: { seeds: '' } } : {}) } } });
    }
    revisions.set(joinMembershipKey(aggregateType, aggregateId), revision);
  }
  for (const chunk of sourceCommitChunks(updates)) {
    const result = await collection.bulkWrite(chunk, { session, ordered: true });
    if (result.matchedCount !== chunk.length || result.modifiedCount !== chunk.length) throw new Error('projection-v2-occ:membership-update');
  }
  for (const chunk of sourceCommitChunks(inserts)) {
    const result = await collection.bulkWrite(chunk, { session, ordered: true });
    if (result.insertedCount !== chunk.length) throw new Error('projection-v2-occ:membership-insert');
  }
  return Object.fromEntries(revisions);
}
