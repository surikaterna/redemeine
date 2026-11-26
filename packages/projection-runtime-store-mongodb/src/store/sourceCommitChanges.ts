import {
  buildProjectionChangesReceipt,
  matchProjectionChangesReceipt,
  projectionChangesIdentity,
  projectionChangesResumeToken,
  type CommitProjectionSourceCommitCommitted,
  type CommitProjectionSourceCommitRequest,
  type CommitProjectionSourceCommitResult,
  type LoadProjectionSourceCommitSnapshotRequest,
  type ProjectionSourceCommitSnapshot
} from '@redemeine/projection-runtime-core';
import type { ClientSession } from 'mongodb';
import type { MongoProjectionChangesRecord, MongoProjectionStoreOptions } from '../types';

type ChangeCollection = NonNullable<MongoProjectionStoreOptions['changeCollection']>;
const changeReceiptReadOptions = { readConcern: 'majority', readPreference: 'primary' } as const;

export class MongoChangeAppendValidationError extends Error {
  constructor(cause: unknown) {
    super('MongoDB rejected the projection_changes turn receipt (document validation, code 121).', { cause });
  }
}

function hasTransactionLabel(error: unknown, label: string): boolean {
  const labelled = error as { hasErrorLabel?: (label: string) => boolean };
  return error instanceof Error && labelled.hasErrorLabel?.(label) === true;
}

export function isUnknownSourceCommitOutcome(error: unknown): boolean {
  return hasTransactionLabel(error, 'UnknownTransactionCommitResult');
}

export function isTransientSourceCommitError(error: unknown): boolean {
  return hasTransactionLabel(error, 'TransientTransactionError');
}

function decodeOutcome(outcome: MongoProjectionChangesRecord['outcome']) {
  const documents = 'documentRevisionEntries' in outcome ? outcome.documentRevisionEntries : Object.entries(outcome.documentRevisions);
  const links = 'linkRevisionEntries' in outcome ? outcome.linkRevisionEntries : Object.entries(outcome.linkRevisions);
  return { progress: outcome.progress, documentRevisions: Object.fromEntries(documents), linkRevisions: Object.fromEntries(links) };
}

export async function readSourceCommitChange(
  request: CommitProjectionSourceCommitRequest,
  collection: ChangeCollection | undefined,
  lookup: { session?: ClientSession; applicationId: string | undefined; recoveringWriteId?: string }
): Promise<CommitProjectionSourceCommitResult | undefined> {
  const identity = projectionChangesIdentity(request);
  if (!identity || !collection) return undefined;
  const { applicationId, session } = lookup;
  const row = await collection.findOne({ _id: projectionChangesResumeToken(request, applicationId) }, session
    ? { session } : changeReceiptReadOptions);
  if (!row) return undefined;
  const { _id, outcome, ...change } = row;
  if (matchProjectionChangesReceipt(identity, change, applicationId) === 'mismatch') {
    return { version: 1, status: 'rejected', category: 'terminal', retryable: false,
      reason: 'projection change source commit or collection identity mismatch' };
  }
  const replayed = applicationId === undefined && lookup.recoveringWriteId !== undefined && outcome.writeId !== lookup.recoveringWriteId;
  return { version: 1, status: 'committed', commitSequence: change.commitSequence, ...(replayed ? { replayed: true } : {}),
    ...decodeOutcome(outcome), ...(change.kind === 'projection_changes' ? { additionalWrites: [change] } : { emptyChangeReceipt: change }) };
}

export async function readSnapshotChangeReceipt(
  request: LoadProjectionSourceCommitSnapshotRequest,
  collection: ChangeCollection | undefined,
  session?: ClientSession
): Promise<ProjectionSourceCommitSnapshot['changeReceipt']> {
  if (!request.changeIdentity || !collection) return undefined;
  const identity = { ...request, ...request.changeIdentity };
  const token = projectionChangesResumeToken(identity);
  const row = await collection.findOne({ _id: token }, session ? { session } : changeReceiptReadOptions);
  return row ? matchProjectionChangesReceipt(identity, row) : 'missing';
}

export async function appendSourceCommitChange(
  request: CommitProjectionSourceCommitRequest,
  result: CommitProjectionSourceCommitCommitted,
  collection: ChangeCollection | undefined,
  session: ClientSession,
  writeId: string
): Promise<CommitProjectionSourceCommitCommitted> {
  const applicationId = request.progress.strategy === 'none' ? writeId : undefined;
  const change = buildProjectionChangesReceipt(request, applicationId);
  if (!change) return result;
  if (!collection) throw new Error('projection_changes collection is not configured');
  const { documentRevisions, linkRevisions, progress } = result;
  const _id = change.resumeToken;
  const row: MongoProjectionChangesRecord = { _id, ...change, outcome: {
    documentRevisionEntries: Object.entries(documentRevisions),
    linkRevisionEntries: Object.entries(linkRevisions),
    progress,
    ...(applicationId === undefined ? { writeId } : {})
  } };
  try {
    const inserted = await collection.updateOne({ _id }, { $setOnInsert: row }, { upsert: true, session }) as
      { upsertedCount?: number };
    if (inserted.upsertedCount !== 1) throw new Error('projection-v2-occ:projection_changes');
  } catch (error) {
    if (error instanceof Error && 'code' in error && !isUnknownSourceCommitOutcome(error) && !isTransientSourceCommitError(error)) {
      if (error.code === 11000) throw new Error('projection-v2-occ:projection_changes', { cause: error });
      if (error.code === 121) throw new MongoChangeAppendValidationError(error);
    }
    throw error;
  }
  return { ...result, ...(change.kind === 'projection_changes' ? { additionalWrites: [change] } : { emptyChangeReceipt: change }) };
}
