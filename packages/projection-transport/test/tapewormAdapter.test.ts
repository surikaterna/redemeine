import { describe, expect, it, jest } from '@jest/globals';
import type { ICommit } from 'tapeworm';
import {
  createTapewormCompleteCommitRangeReader,
  decodeTapewormProjectionCommit,
  type TapewormIndexedCommitRangeCapability
} from '../src';

const STREAM = '11111111-1111-4111-8111-111111111111';
const COMMIT = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';

function wire(sequence = 0, eventCount = 2): ICommit {
  return {
    id: sequence === 0 ? COMMIT : `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
    partitionId: 'orders',
    streamId: STREAM,
    commitSequence: sequence,
    headers: { trace: 'commit-header' },
    metadata: { tenant: 'commit-metadata' },
    events: Array.from({ length: eventCount }, (_, index) => ({
      id: index === 0 ? EVENT : `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      type: `Event${index}`,
      version: sequence * 2 + index,
      aggregateType: 'Order',
      aggregateId: 'order-1',
      payload: { index },
      timestamp: '2026-09-22T00:00:00.000Z',
      headers: { eventHeader: index },
      metadata: { eventMetadata: index }
    }))
  };
}

describe('Tapeworm complete commit adapter', () => {
  it('decodes sequence zero and preserves the complete ordered commit wire', () => {
    const decoded = decodeTapewormProjectionCommit(wire(), COMMIT);
    expect(decoded).toEqual({
      status: 'valid',
      commit: {
        streamId: STREAM,
        commitId: COMMIT,
        commitSequence: 0,
        headers: { trace: 'commit-header' },
        metadata: { tenant: 'commit-metadata' },
        events: [
          expect.objectContaining({ eventIndex: 0, streamVersion: 0, headers: { eventHeader: 0 } }),
          expect.objectContaining({ eventIndex: 1, streamVersion: 1, metadata: { eventMetadata: 1 } })
        ]
      }
    });
  });

  it.each([
    ['missing message identity', undefined, wire()],
    ['different message identity', EVENT, wire()],
    ['noncanonical stream identity', COMMIT, { ...wire(), streamId: 'local-order-1' }],
    ['partial empty commit', COMMIT, { ...wire(), events: [] }]
  ])('rejects %s', (_label, messageId, candidate) => {
    expect(decodeTapewormProjectionCommit(candidate, messageId).status).toBe('malformed');
  });

  it('uses only the indexed complete-boundary capability and enforces both bounds', async () => {
    const query = jest.fn<TapewormIndexedCommitRangeCapability['readCommitRangeByCommitSequence']>();
    query.mockResolvedValue([wire(0), wire(1), wire(2)].map((commit) => ({
      commit, encodedByteLength: Buffer.byteLength(JSON.stringify(commit))
    })));
    const reader = createTapewormCompleteCommitRangeReader({
      completeCommitBoundaries: true,
      indexedByCommitSequence: true,
      readCommitRangeByCommitSequence: query
    });
    const oneBytes = Buffer.byteLength(JSON.stringify(wire(0)));
    const result = await reader.readCompleteRange({
      sourceId: STREAM, afterSequence: null, throughSequence: 2, maxCommits: 2, maxBytes: oneBytes
    });
    expect(query).toHaveBeenCalledWith({
      streamId: STREAM, afterCommitSequence: null, throughCommitSequence: 2, limit: 3
    });
    expect(result).toMatchObject({ status: 'complete', encodedByteLength: oneBytes, continuationAfterSequence: 0, hasMore: true });
    if (result.status === 'complete') expect(result.commits).toHaveLength(1);
  });

  it('reports an exact oversized first commit without advancing', async () => {
    const first = wire();
    const bytes = Buffer.byteLength(JSON.stringify(first));
    const reader = createTapewormCompleteCommitRangeReader({
      completeCommitBoundaries: true,
      indexedByCommitSequence: true,
      readCommitRangeByCommitSequence: async () => [{ commit: first, encodedByteLength: bytes }]
    });
    await expect(reader.readCompleteRange({
      sourceId: STREAM, afterSequence: null, throughSequence: 0, maxCommits: 1, maxBytes: bytes - 1
    })).resolves.toEqual({
      status: 'oversized_commit', sourceId: STREAM, commitSequence: 0, commitId: COMMIT,
      encodedByteLength: bytes, continuationAfterSequence: null
    });
  });

  it('fails closed when indexed history starts after the requested boundary', async () => {
    const reader = createTapewormCompleteCommitRangeReader({
      completeCommitBoundaries: true,
      indexedByCommitSequence: true,
      readCommitRangeByCommitSequence: async () => [{ commit: wire(1), encodedByteLength: 500 }]
    });
    await expect(reader.readCompleteRange({
      sourceId: STREAM, afterSequence: null, throughSequence: 1, maxCommits: 2, maxBytes: 100_000
    })).resolves.toMatchObject({ status: 'incomplete', reason: 'history_unavailable', continuationAfterSequence: null });
  });
});
