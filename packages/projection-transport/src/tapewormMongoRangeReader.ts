import {
  isCanonicalProjectionUuid,
  type ProjectionCompleteCommitRangeReader,
  type ProjectionCompleteCommitRangeRequest,
  type ProjectionCompleteCommitRangeResult,
  type ProjectionEncodedSourceCommit
} from '@redemeine/projection-runtime-core';
import { BSON, type Collection, type IndexDescriptionInfo } from 'mongodb';
import type { IBaseEvent, ICommit } from 'tapeworm';
import { decodeTapewormProjectionCommit, type TapewormProjectionEvent } from './tapewormDecoder';

const RANGE_INDEX_KEYS = ['streamId', 'commitSequence'] as const;

export interface TapewormMongoRangeReaderOptions<TEvent extends IBaseEvent = TapewormProjectionEvent> {
  readonly collection: Collection<ICommit<TEvent>>;
  readonly partitionId: string;
}

export interface TapewormMongoRangeReader extends ProjectionCompleteCommitRangeReader {
  initialize(): Promise<void>;
  probeSource(sourceId: string, lastAcceptedSequence: number): Promise<number>;
  getIndexName(): string | null;
  getQueryObservation(): TapewormMongoRangeQueryObservation;
}

export interface TapewormMongoRangeQueryObservation {
  readonly cursorMethod: 'find.sort.hint.limit.batchSize.asyncIterator';
  readonly maxReturnedDocuments: number;
  readonly maxReturnedBytes: number;
  readonly sourceProbeMethod: 'findOne.hint + find.sort(-1).hint.limit(1)';
}

function hasExactKeys(index: IndexDescriptionInfo): boolean {
  if (!index.key || typeof index.key !== 'object') return false;
  const entries = Object.entries(index.key);
  return entries.length === 2 && entries.every(([key, direction], position) => key === RANGE_INDEX_KEYS[position] && direction === 1);
}

function hasCompatibleCollation(index: IndexDescriptionInfo): boolean {
  return index.collation === undefined || index.collation.locale === 'simple';
}

function isUsableRangeIndex(index: IndexDescriptionInfo): index is IndexDescriptionInfo & { name: string } {
  return (
    typeof index.name === 'string' &&
    hasExactKeys(index) &&
    index.unique === true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.expireAfterSeconds === undefined &&
    index.partialFilterExpression === undefined &&
    hasCompatibleCollation(index)
  );
}

function incomplete(request: ProjectionCompleteCommitRangeRequest, details: string): ProjectionCompleteCommitRangeResult {
  return { status: 'incomplete', reason: 'history_unavailable', details, continuationAfterSequence: request.afterSequence };
}

function decodeRow<TEvent extends IBaseEvent>(
  row: ICommit<TEvent>,
  partitionId: string,
  sourceId: string,
  expectedSequence: number,
  throughSequence: number
): ProjectionEncodedSourceCommit | string {
  if (row.partitionId !== partitionId) return 'Tapeworm partitionId does not match the configured collection.';
  if (row.streamId !== sourceId) return 'Tapeworm range returned the wrong stream.';
  if (row.commitSequence !== expectedSequence || row.commitSequence > throughSequence) {
    return 'Tapeworm commit sequence is missing, duplicated, or outside the requested range.';
  }
  const decoded = decodeTapewormProjectionCommit(row, row.id);
  if (decoded.status === 'malformed') return decoded.reason;
  return { commit: decoded.commit, encodedByteLength: BSON.calculateObjectSize(row) };
}

function oversized(request: ProjectionCompleteCommitRangeRequest, entry: ProjectionEncodedSourceCommit): ProjectionCompleteCommitRangeResult {
  return {
    status: 'oversized_commit',
    sourceId: request.sourceId,
    commitSequence: entry.commit.commitSequence,
    commitId: entry.commit.commitId,
    encodedByteLength: entry.encodedByteLength,
    continuationAfterSequence: request.afterSequence
  };
}

export function createTapewormMongoCompleteCommitRangeReader<TEvent extends IBaseEvent = TapewormProjectionEvent>(
  options: TapewormMongoRangeReaderOptions<TEvent>
): TapewormMongoRangeReader {
  let indexName: string | null = null;
  let maxReturnedDocuments = 0;
  let maxReturnedBytes = 0;
  const initialize = async (): Promise<void> => {
    const indexes = await options.collection.listIndexes().toArray();
    const usable = indexes.filter(isUsableRangeIndex);
    if (usable.length !== 1) throw new Error('Exactly one usable Tapeworm streamId/commitSequence index is required.');
    indexName = usable[0]?.name ?? null;
  };
  const readCompleteRange = async (request: ProjectionCompleteCommitRangeRequest): Promise<ProjectionCompleteCommitRangeResult> => {
    await initialize();
    if (!indexName) return incomplete(request, 'Tapeworm range index readiness failed.');
    const result = await readMongoRange(options, indexName, request);
    if (result.status === 'complete') {
      maxReturnedDocuments = Math.max(maxReturnedDocuments, result.commits.length);
      maxReturnedBytes = Math.max(maxReturnedBytes, result.encodedByteLength);
    }
    return result;
  };
  const probeSource = async (sourceId: string, b: number): Promise<number> => {
    await initialize();
    if (!indexName || !isCanonicalProjectionUuid(sourceId) || !Number.isSafeInteger(b) || b < -1) {
      throw new Error('Invalid indexed source boundary.');
    }
    const collection = options.collection;
    if (b >= 0) {
      const boundary = await collection.findOne({ streamId: sourceId, commitSequence: b }, { hint: indexName });
      if (!boundary || typeof decodeRow(boundary, options.partitionId, sourceId, b, b) === 'string') {
        throw new Error('Accepted source boundary B is missing or malformed.');
      }
    }
    const highest = await collection.find({ streamId: sourceId }).sort({ commitSequence: -1 })
      .hint(indexName).limit(1).next();
    if (!highest) {
      if (b !== -1) throw new Error('Accepted source boundary B is missing.');
      return -1;
    }
    const h = highest.commitSequence;
    if (!Number.isSafeInteger(h) || h < b || typeof decodeRow(highest, options.partitionId, sourceId, h, h) === 'string') {
      throw new Error('Indexed source high watermark is malformed or precedes B.');
    }
    return h;
  };
  return {
    capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    initialize,
    probeSource,
    getIndexName: () => indexName,
    getQueryObservation: () => ({ cursorMethod: 'find.sort.hint.limit.batchSize.asyncIterator', maxReturnedDocuments, maxReturnedBytes,
      sourceProbeMethod: 'findOne.hint + find.sort(-1).hint.limit(1)' }),
    readCompleteRange
  };
}

async function readMongoRange<TEvent extends IBaseEvent>(
  options: TapewormMongoRangeReaderOptions<TEvent>,
  indexName: string,
  request: ProjectionCompleteCommitRangeRequest
): Promise<ProjectionCompleteCommitRangeResult> {
  const after = request.afterSequence ?? -1;
  const cursor = options.collection
    .find({
      streamId: request.sourceId,
      commitSequence: { $gt: after, $lte: request.throughSequence }
    })
    .sort({ commitSequence: 1 })
    .hint(indexName)
    .limit(request.maxCommits + 1)
    .batchSize(1);
  const commits: ProjectionEncodedSourceCommit[] = [];
  let bytes = 0;
  let expected = after + 1;
  for await (const row of cursor) {
    const decoded = decodeRow(row, options.partitionId, request.sourceId, expected, request.throughSequence);
    if (typeof decoded === 'string') return incomplete(request, decoded);
    if (commits.length === 0 && decoded.encodedByteLength > request.maxBytes) return oversized(request, decoded);
    if (commits.length >= request.maxCommits || bytes + decoded.encodedByteLength > request.maxBytes) {
      return completePage(request, commits, bytes, true);
    }
    commits.push(decoded);
    bytes += decoded.encodedByteLength;
    expected += 1;
  }
  if (expected <= request.throughSequence) return incomplete(request, 'Tapeworm history ended before the requested sequence.');
  return completePage(request, commits, bytes, false);
}

function completePage(
  request: ProjectionCompleteCommitRangeRequest,
  commits: readonly ProjectionEncodedSourceCommit[],
  encodedByteLength: number,
  hasMore: boolean
): ProjectionCompleteCommitRangeResult {
  return {
    status: 'complete',
    commits,
    encodedByteLength,
    continuationAfterSequence: commits.at(-1)?.commit.commitSequence ?? request.afterSequence,
    hasMore
  };
}
