import { describe, expect, test } from '@jest/globals';
import type { Checkpoint, IProjectionStore } from '../src/contracts';
import { MongoProjectionStore } from '../src';
import { createProjectionDedupeCollection, createProjectionDocumentCollection, createProjectionLinkCollection } from './mocks';

const createStore = <TState = unknown>() => {
  const collection = createProjectionDocumentCollection<TState>();
  const linkCollection = createProjectionLinkCollection();
  const dedupeCollection = createProjectionDedupeCollection();
  const store = new MongoProjectionStore<TState>({ collection, linkCollection, dedupeCollection });
  return { store, collection, linkCollection, dedupeCollection };
};

describe('MongoProjectionStore', () => {
  test('implements IProjectionStore contract', () => {
    const { store } = createStore<{ count: number }>();
    const typed: IProjectionStore<{ count: number }> = store;

    expect(typeof typed.load).toBe('function');
    expect(typeof typed.save).toBe('function');
    expect(typeof typed.commitAtomic).toBe('function');
    expect(typeof typed.resolveTarget).toBe('function');
    expect(typeof typed.getDedupeCheckpoint).toBe('function');
  });

  test('save/load persists state with checkpoint atomically', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();
    const now = () => '2026-04-09T00:00:00.000Z';
    const store = new MongoProjectionStore<{ count: number }>({ collection, linkCollection, dedupeCollection, now });

    const checkpoint: Checkpoint = { sequence: 11, timestamp: '2026-04-09T00:00:00.000Z' };
    await store.save('doc-1', { count: 42 }, checkpoint);

    expect(await store.load('doc-1')).toEqual({ count: 42 });
    expect(await store.getCheckpoint?.('doc-1')).toEqual(checkpoint);

    const snapshot = collection.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({
      _id: 'doc-1',
      state: { count: 42 },
      checkpoint,
      updatedAt: '2026-04-09T00:00:00.000Z'
    });
  });

  test('load/getCheckpoint return null for unknown document', async () => {
    const { store } = createStore();

    expect(await store.load('missing')).toBeNull();
    expect(await store.getCheckpoint?.('missing')).toBeNull();
    expect(await store.getDedupeCheckpoint('missing')).toBeNull();
    expect(await store.resolveTarget('invoice', 'missing')).toBeNull();
  });

  test('delete removes existing projection record', async () => {
    const { store } = createStore<{ count: number }>();

    await store.save('doc-2', { count: 1 }, { sequence: 1 });
    expect(await store.load('doc-2')).toEqual({ count: 1 });

    await store.delete?.('doc-2');

    expect(await store.load('doc-2')).toBeNull();
    expect(await store.getCheckpoint?.('doc-2')).toBeNull();
  });

  test('commitAtomic persists docs links cursor and dedupe in one write contract', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();
    const now = () => '2026-04-09T00:00:00.000Z';
    const store = new MongoProjectionStore<{ count: number }>({ collection, linkCollection, dedupeCollection, now });

    await store.commitAtomic({
      documents: [
        {
          documentId: 'doc-atomic',
          state: { count: 7 },
          checkpoint: { sequence: 7, timestamp: '2026-04-09T00:00:07.000Z' }
        }
      ],
      links: [
        {
          aggregateType: 'invoice',
          aggregateId: 'inv-1',
          targetDocId: 'doc-atomic'
        }
      ],
      cursorKey: '__cursor__projection-a',
      cursor: { sequence: 7, timestamp: '2026-04-09T00:00:07.000Z' },
      dedupe: {
        upserts: [
          {
            key: 'invoice:inv-1:7',
            checkpoint: { sequence: 7, timestamp: '2026-04-09T00:00:07.000Z' }
          }
        ]
      }
    });

    expect(await store.load('doc-atomic')).toEqual({ count: 7 });
    expect(await store.resolveTarget('invoice', 'inv-1')).toBe('doc-atomic');
    expect(await store.getCheckpoint?.('__cursor__projection-a')).toEqual({
      sequence: 7,
      timestamp: '2026-04-09T00:00:07.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:inv-1:7')).toEqual({
      sequence: 7,
      timestamp: '2026-04-09T00:00:07.000Z'
    });

    expect(linkCollection.snapshot()).toEqual([
      {
        _id: 'invoice:inv-1',
        aggregateType: 'invoice',
        aggregateId: 'inv-1',
        targetDocId: 'doc-atomic',
        createdAt: '2026-04-09T00:00:00.000Z'
      }
    ]);
  });

  test('commitAtomic failure before first write leaves no partial state or dedupe/cursor drift', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();

    const failingCollection = {
      findOne: collection.findOne.bind(collection),
      deleteOne: collection.deleteOne.bind(collection),
      deleteMany: collection.deleteMany.bind(collection),
      async updateOne(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: { upsert?: boolean }
      ): Promise<unknown> {
        void filter;
        void update;
        void options;
        throw new Error('injected pre-write failure');
      }
    };

    const store = new MongoProjectionStore<{ count: number }>({
      collection: failingCollection,
      linkCollection,
      dedupeCollection
    });

    await expect(
      store.commitAtomic({
        documents: [
          {
            documentId: 'doc-fail',
            state: { count: 1 },
            checkpoint: { sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' }
          }
        ],
        links: [
          {
            aggregateType: 'invoice',
            aggregateId: 'inv-fail',
            targetDocId: 'doc-fail'
          }
        ],
        cursorKey: '__cursor__projection-fail',
        cursor: { sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' },
        dedupe: {
          upserts: [
            {
              key: 'invoice:inv-fail:1',
              checkpoint: { sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' }
            }
          ]
        }
      })
    ).rejects.toThrow('injected pre-write failure');

    expect(await store.load('doc-fail')).toBeNull();
    expect(await store.resolveTarget('invoice', 'inv-fail')).toBeNull();
    expect(await store.getCheckpoint?.('__cursor__projection-fail')).toBeNull();
    expect(await store.getDedupeCheckpoint('invoice:inv-fail:1')).toBeNull();
    expect(linkCollection.snapshot()).toEqual([]);
    expect(dedupeCollection.snapshot()).toEqual([]);
  });

  test('commitAtomic replay of same write is idempotent for doc/link/cursor/dedupe records', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();
    const now = () => '2026-04-09T00:00:00.000Z';
    const store = new MongoProjectionStore<{ count: number }>({ collection, linkCollection, dedupeCollection, now });

    const write = {
      documents: [
        {
          documentId: 'doc-retry',
          state: { count: 9 },
          checkpoint: { sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' }
        }
      ],
      links: [
        {
          aggregateType: 'invoice',
          aggregateId: 'inv-retry',
          targetDocId: 'doc-retry'
        }
      ],
      cursorKey: '__cursor__projection-retry',
      cursor: { sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' },
      dedupe: {
        upserts: [
          {
            key: 'invoice:inv-retry:9',
            checkpoint: { sequence: 9, timestamp: '2026-04-09T00:00:09.000Z' }
          }
        ]
      }
    };

    await store.commitAtomic(write);
    await store.commitAtomic(write);

    expect(await store.load('doc-retry')).toEqual({ count: 9 });
    expect(await store.resolveTarget('invoice', 'inv-retry')).toBe('doc-retry');
    expect(await store.getCheckpoint?.('__cursor__projection-retry')).toEqual({
      sequence: 9,
      timestamp: '2026-04-09T00:00:09.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:inv-retry:9')).toEqual({
      sequence: 9,
      timestamp: '2026-04-09T00:00:09.000Z'
    });

    expect(collection.snapshot()).toHaveLength(2);
    expect(linkCollection.snapshot()).toHaveLength(1);
    expect(dedupeCollection.snapshot()).toHaveLength(1);
  });
});
