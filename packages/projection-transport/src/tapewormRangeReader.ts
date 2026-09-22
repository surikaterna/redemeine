import type {
  ProjectionCompleteCommitRangeReader,
  ProjectionCompleteCommitRangeRequest,
  ProjectionCompleteCommitRangeResult,
  ProjectionEncodedSourceCommit
} from '@redemeine/projection-runtime-core';
import type { ICommit } from 'tapeworm';
import { decodeTapewormProjectionCommit } from './tapewormDecoder';

export interface TapewormIndexedCommitRangeCapability {
  readonly completeCommitBoundaries: true;
  readonly indexedByCommitSequence: true;
  readCommitRangeByCommitSequence(request: {
    streamId: string;
    afterCommitSequence: number | null;
    throughCommitSequence: number;
    limit: number;
  }): Promise<readonly TapewormIndexedCommit[]>;
}

export interface TapewormIndexedCommit {
  readonly commit: ICommit;
  /** Exact persisted/wire byte count supplied by the indexed Tapeworm persistence capability. */
  readonly encodedByteLength: number;
}

function encodedEntry(entry: TapewormIndexedCommit): ProjectionEncodedSourceCommit | null {
  const decoded = decodeTapewormProjectionCommit(entry.commit, entry.commit.id);
  if (decoded.status === 'malformed') return null;
  if (!Number.isSafeInteger(entry.encodedByteLength) || entry.encodedByteLength <= 0) return null;
  return { commit: decoded.commit, encodedByteLength: entry.encodedByteLength };
}

function unavailable(request: ProjectionCompleteCommitRangeRequest, details: string): ProjectionCompleteCommitRangeResult {
  return { status: 'incomplete', reason: 'history_unavailable', details, continuationAfterSequence: request.afterSequence };
}

export function createTapewormCompleteCommitRangeReader(
  source: TapewormIndexedCommitRangeCapability
): ProjectionCompleteCommitRangeReader {
  if (source.completeCommitBoundaries !== true || source.indexedByCommitSequence !== true) {
    throw new Error('Tapeworm indexed complete-commit capability is required. queryStream is not safe for this adapter.');
  }
  return {
    capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    async readCompleteRange(request) {
      const wires = await source.readCommitRangeByCommitSequence({
        streamId: request.sourceId,
        afterCommitSequence: request.afterSequence,
        throughCommitSequence: request.throughSequence,
        limit: request.maxCommits + 1
      });
      const entries = wires.map(encodedEntry);
      if (entries.some((entry) => entry === null)) return unavailable(request, 'Tapeworm returned a malformed or sliced commit.');
      const completeEntries = entries.filter((entry): entry is ProjectionEncodedSourceCommit => entry !== null);
      return boundEntries(request, completeEntries);
    }
  };
}

function boundEntries(
  request: ProjectionCompleteCommitRangeRequest,
  entries: readonly ProjectionEncodedSourceCommit[]
): ProjectionCompleteCommitRangeResult {
  const expected = request.afterSequence === null ? 0 : request.afterSequence + 1;
  const first = entries[0];
  if (first && first.commit.commitSequence !== expected) return unavailable(request, 'Indexed history does not begin at the requested commit.');
  if (first && first.encodedByteLength > request.maxBytes) {
    return {
      status: 'oversized_commit', sourceId: request.sourceId, commitSequence: first.commit.commitSequence,
      commitId: first.commit.commitId, encodedByteLength: first.encodedByteLength,
      continuationAfterSequence: request.afterSequence
    };
  }
  const accepted: ProjectionEncodedSourceCommit[] = [];
  let bytes = 0;
  for (const entry of entries.slice(0, request.maxCommits)) {
    if (bytes + entry.encodedByteLength > request.maxBytes) break;
    accepted.push(entry);
    bytes += entry.encodedByteLength;
  }
  const continuation = accepted.at(-1)?.commit.commitSequence ?? request.afterSequence;
  const hasMore = entries.length > accepted.length || (continuation ?? -1) < request.throughSequence;
  return { status: 'complete', commits: accepted, encodedByteLength: bytes, continuationAfterSequence: continuation, hasMore };
}
