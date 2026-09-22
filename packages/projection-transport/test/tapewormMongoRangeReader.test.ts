import { describe, expect, it, jest } from '@jest/globals';
import { BSON, type Collection, type IndexDescriptionInfo } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { createTapewormMongoCompleteCommitRangeReader } from '../src';

const STREAM = '11111111-1111-4111-8111-111111111111';
const PARTITION = 'orders';

function commit(sequence: number, eventCount = 1): ICommit {
  return {
    id: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
    partitionId: PARTITION,
    streamId: STREAM,
    commitSequence: sequence,
    events: Array.from({ length: eventCount }, (_, index) => ({
      id: `33333333-3333-4333-8333-${String(sequence * 10 + index).padStart(12, '0')}`,
      type: `Changed${index}`,
      version: sequence * 10 + index,
      aggregateType: 'Order',
      aggregateId: 'one',
      payload: { sequence, index },
      timestamp: '2026-09-22T00:00:00.000Z'
    }))
  };
}

const validIndex: IndexDescriptionInfo = {
  name: 'streamId_1_commitSequence_1',
  key: { streamId: 1, commitSequence: 1 },
  unique: true,
  v: 2
};

class FakeCursor {
  readonly calls: Array<readonly [string, unknown]> = [];
  private maximum = Number.POSITIVE_INFINITY;

  constructor(private readonly rows: readonly ICommit[]) {}

  sort(value: unknown): this { this.calls.push(['sort', value]); return this; }
  hint(value: unknown): this { this.calls.push(['hint', value]); return this; }
  limit(value: number): this { this.calls.push(['limit', value]); this.maximum = value; return this; }
  batchSize(value: number): this { this.calls.push(['batchSize', value]); return this; }

  async *[Symbol.asyncIterator](): AsyncGenerator<ICommit> {
    for (const row of this.rows.slice(0, this.maximum)) yield row;
  }
}

function collection(rows: readonly ICommit[], indexes: readonly IndexDescriptionInfo[] = [validIndex]) {
  const cursor = new FakeCursor(rows);
  const find = jest.fn(() => cursor);
  const value = {
    find,
    listIndexes: () => ({ toArray: async () => [...indexes] })
  } as unknown as Collection<ICommit>;
  return { value, cursor, find };
}

const request = {
  sourceId: STREAM,
  afterSequence: null,
  throughSequence: 2,
  maxCommits: 1,
  maxBytes: 1_000_000
} as const;

describe('Tapeworm Mongo complete range reader', () => {
  it('uses the exact indexed bounded cursor and returns whole multi-event commits', async () => {
    const source = collection([commit(0, 2), commit(1), commit(2)]);
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source.value, partitionId: PARTITION });
    const result = await reader.readCompleteRange(request);
    expect(source.find).toHaveBeenCalledWith({
      streamId: STREAM, commitSequence: { $gt: -1, $lte: 2 }
    });
    expect(source.cursor.calls).toEqual([
      ['sort', { commitSequence: 1 }],
      ['hint', validIndex.name],
      ['limit', 2],
      ['batchSize', 1]
    ]);
    expect(result).toMatchObject({ status: 'complete', continuationAfterSequence: 0, hasMore: true });
    if (result.status === 'complete') {
      expect(result.commits).toHaveLength(1);
      expect(result.commits[0]?.commit.events).toHaveLength(2);
      expect(result.commits[0]?.encodedByteLength).toBe(BSON.calculateObjectSize(commit(0, 2)));
    }
  });

  it('applies exact BSON byte truncation and first-commit oversized semantics', async () => {
    const rows = [commit(0), commit(1)];
    const firstBytes = BSON.calculateObjectSize(rows[0] as ICommit);
    const source = collection(rows);
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source.value, partitionId: PARTITION });
    const page = await reader.readCompleteRange({ ...request, maxCommits: 2, throughSequence: 1, maxBytes: firstBytes });
    expect(page).toMatchObject({ status: 'complete', encodedByteLength: firstBytes, continuationAfterSequence: 0, hasMore: true });

    const oversized = await reader.readCompleteRange({ ...request, throughSequence: 0, maxBytes: firstBytes - 1 });
    expect(oversized).toMatchObject({
      status: 'oversized_commit', commitSequence: 0, encodedByteLength: firstBytes, continuationAfterSequence: null
    });
  });

  it.each([
    ['gap', [commit(1)]],
    ['wrong partition', [{ ...commit(0), partitionId: 'other' }]],
    ['malformed event array', [{ ...commit(0), events: [] }]],
    ['wrong stream', [{ ...commit(0), streamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]]
  ])('fails closed for %s', async (_label, rows) => {
    const source = collection(rows);
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source.value, partitionId: PARTITION });
    await expect(reader.readCompleteRange({ ...request, throughSequence: 0 })).resolves.toMatchObject({
      status: 'incomplete', reason: 'history_unavailable', continuationAfterSequence: null
    });
  });

  it.each([
    ['missing', []],
    ['nonunique', [{ ...validIndex, unique: false }]],
    ['partial', [{ ...validIndex, partialFilterExpression: { streamId: { $exists: true } } }]],
    ['sparse', [{ ...validIndex, sparse: true }]],
    ['hidden', [{ ...validIndex, hidden: true }]],
    ['reversed', [{ ...validIndex, key: { commitSequence: 1, streamId: 1 } }]],
    ['extra key', [{ ...validIndex, key: { streamId: 1, commitSequence: 1, id: 1 } }]],
    ['incompatible collation', [{ ...validIndex, collation: { locale: 'en' } }]]
  ] satisfies ReadonlyArray<readonly [string, readonly IndexDescriptionInfo[]]>)('rejects a %s range index', async (_label, indexes) => {
    const source = collection([], indexes);
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source.value, partitionId: PARTITION });
    await expect(reader.initialize()).rejects.toThrow('Exactly one usable');
  });

  it('accepts an explicit simple collation and rechecks readiness on every read', async () => {
    const source = collection([commit(0)], [{ ...validIndex, collation: { locale: 'simple' } }]);
    const listIndexes = jest.spyOn(source.value, 'listIndexes');
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: source.value, partitionId: PARTITION });
    await reader.initialize();
    await reader.readCompleteRange({ ...request, throughSequence: 0 });
    expect(listIndexes).toHaveBeenCalledTimes(2);
    expect(reader.getIndexName()).toBe(validIndex.name);
  });
});
