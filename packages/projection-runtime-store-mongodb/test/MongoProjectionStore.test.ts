import { describe, expect, test } from '@jest/globals';
import type { Checkpoint, IProjectionStore } from '../src/contracts';
import { MongoProjectionStore } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from './mocks';

const createStore = <TState = unknown>() => {
  const collection = createProjectionDocumentCollection<TState>();
  const linkCollection = createProjectionLinkCollection();
  const dedupeCollection = createProjectionDedupeCollection();
  const store = new MongoProjectionStore<TState>({
    collection,
    linkCollection,
    dedupeCollection,
    mongoClient: createFakeMongoClient()
  });
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
    const store = new MongoProjectionStore<{ count: number }>({
      collection,
      linkCollection,
      dedupeCollection,
      now,
      mongoClient: createFakeMongoClient()
    });

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
    const store = new MongoProjectionStore<{ count: number }>({
      collection,
      linkCollection,
      dedupeCollection,
      now,
      mongoClient: createFakeMongoClient()
    });

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

  test('commitAtomic failure on projection bulkWrite leaves no partial state or dedupe/cursor drift', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();

    const failingCollection = {
      findOne: collection.findOne.bind(collection),
      deleteOne: collection.deleteOne.bind(collection),
      deleteMany: collection.deleteMany.bind(collection),
      updateOne: collection.updateOne.bind(collection),
      async bulkWrite(): Promise<unknown> {
        throw new Error('injected pre-write failure');
      }
    };

    const store = new MongoProjectionStore<{ count: number }>({
      collection: failingCollection,
      linkCollection,
      dedupeCollection,
      mongoClient: createFakeMongoClient()
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
    const store = new MongoProjectionStore<{ count: number }>({
      collection,
      linkCollection,
      dedupeCollection,
      now,
      mongoClient: createFakeMongoClient()
    });

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

  test('commitAtomic fault during dedupe bulkWrite recovers deterministically on retry without duplicate artifacts', async () => {
    const collection = createProjectionDocumentCollection<{ count: number }>();
    const linkCollection = createProjectionLinkCollection();
    const dedupeCollection = createProjectionDedupeCollection();

    let shouldFailDedupeWrite = true;
    const failingDedupeCollection = {
      findOne: dedupeCollection.findOne.bind(dedupeCollection),
      deleteOne: dedupeCollection.deleteOne.bind(dedupeCollection),
      deleteMany: dedupeCollection.deleteMany.bind(dedupeCollection),
      updateOne: dedupeCollection.updateOne.bind(dedupeCollection),
      async bulkWrite(...args: Parameters<typeof dedupeCollection.bulkWrite>): Promise<unknown> {
        if (shouldFailDedupeWrite) {
          shouldFailDedupeWrite = false;
          throw new Error('injected dedupe write failure');
        }

        return dedupeCollection.bulkWrite(...args);
      }
    };

    const now = () => '2026-04-09T00:00:00.000Z';
    const store = new MongoProjectionStore<{ count: number }>({
      collection,
      linkCollection,
      dedupeCollection: failingDedupeCollection,
      now,
      mongoClient: createFakeMongoClient()
    });

    const write = {
      documents: [
        {
          documentId: 'doc-fault-retry',
          state: { count: 5 },
          checkpoint: { sequence: 5, timestamp: '2026-04-09T00:00:05.000Z' }
        }
      ],
      links: [
        {
          aggregateType: 'invoice',
          aggregateId: 'inv-fault-retry',
          targetDocId: 'doc-fault-retry'
        }
      ],
      cursorKey: '__cursor__projection-fault-retry',
      cursor: { sequence: 5, timestamp: '2026-04-09T00:00:05.000Z' },
      dedupe: {
        upserts: [
          {
            key: 'invoice:inv-fault-retry:5',
            checkpoint: { sequence: 5, timestamp: '2026-04-09T00:00:05.000Z' }
          }
        ]
      }
    };

    await expect(store.commitAtomic(write)).rejects.toThrow('injected dedupe write failure');

    await store.commitAtomic(write);

    expect(await store.load('doc-fault-retry')).toEqual({ count: 5 });
    expect(await store.resolveTarget('invoice', 'inv-fault-retry')).toBe('doc-fault-retry');
    expect(await store.getCheckpoint?.('__cursor__projection-fault-retry')).toEqual({
      sequence: 5,
      timestamp: '2026-04-09T00:00:05.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:inv-fault-retry:5')).toEqual({
      sequence: 5,
      timestamp: '2026-04-09T00:00:05.000Z'
    });

    expect(collection.snapshot()).toHaveLength(2);
    expect(linkCollection.snapshot()).toHaveLength(1);
    expect(dedupeCollection.snapshot()).toHaveLength(1);
  });

  test('commitAtomic uses bulkWrite for projection, links, and dedupe paths', async () => {
    const { store, collection, linkCollection, dedupeCollection } = createStore<{ count: number }>();

    await store.commitAtomic({
      documents: [
        {
          documentId: 'doc-bulk-path',
          state: { count: 11 },
          checkpoint: { sequence: 11 }
        }
      ],
      links: [
        {
          aggregateType: 'invoice',
          aggregateId: 'inv-bulk-path',
          targetDocId: 'doc-bulk-path'
        }
      ],
      cursorKey: '__cursor__bulk-path',
      cursor: { sequence: 11 },
      dedupe: {
        upserts: [{ key: 'invoice:inv-bulk-path:11', checkpoint: { sequence: 11 } }]
      }
    });

    expect(collection.operationLog.some((entry) => entry.op === 'bulkWrite')).toBe(true);
    expect(linkCollection.operationLog.some((entry) => entry.op === 'bulkWrite')).toBe(true);
    expect(dedupeCollection.operationLog.some((entry) => entry.op === 'bulkWrite')).toBe(true);
  });

  test('commitAtomicMany rejects with terminal failure when transactions are unsupported', async () => {
    const mongoClient = createFakeMongoClient({
      failWithTransactionError: Object.assign(
        new Error('Transaction numbers are only allowed on a replica set member or mongos'),
        {
          name: 'MongoServerError',
          code: 20
        }
      )
    });

    const store = new MongoProjectionStore<{ count: number }>({
      collection: createProjectionDocumentCollection<{ count: number }>(),
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: createProjectionDedupeCollection(),
      mongoClient
    });

    const result = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: 'invoice-summary:doc-1',
          documents: [
            {
              documentId: 'doc-1',
              mode: 'full',
              fullDocument: { count: 1 },
              checkpoint: { sequence: 1 }
            }
          ],
          dedupe: { upserts: [] }
        }
      ]
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.failure).toEqual({
        category: 'terminal',
        code: 'transactions-not-supported',
        message:
          'MongoDB transactions are required for atomic projection store operations. Configure a replica set or sharded deployment with transactions enabled.',
        retryable: false
      });
    }
  });
});
