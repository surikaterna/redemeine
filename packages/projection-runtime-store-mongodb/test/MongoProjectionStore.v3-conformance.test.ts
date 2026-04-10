import { describe, expect, test } from 'bun:test';
import { MongoProjectionStore } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from './mocks';
import { runV3StoreConformance } from './v3StoreConformanceHarness';

describe('shared v3 conformance', () => {
  runV3StoreConformance('mongodb', () => {
    return new MongoProjectionStore<Record<string, unknown>>({
      collection: createProjectionDocumentCollection<Record<string, unknown>>(),
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: createProjectionDedupeCollection(),
      mongoClient: createFakeMongoClient()
    });
  });

  test('atomicMany rollback restores state when a later write fails', async () => {
    const collection = createProjectionDocumentCollection<Record<string, unknown>>();
    const dedupeCollection = createProjectionDedupeCollection();

    let shouldFail = true;
    const failingDedupeCollection = {
      findOne: dedupeCollection.findOne.bind(dedupeCollection),
      deleteOne: dedupeCollection.deleteOne.bind(dedupeCollection),
      deleteMany: dedupeCollection.deleteMany.bind(dedupeCollection),
      updateOne: dedupeCollection.updateOne.bind(dedupeCollection),
      async bulkWrite(...args: Parameters<typeof dedupeCollection.bulkWrite>): Promise<unknown> {
        const hasFailingOp = args[0].some((operation) => {
          if (!('updateOne' in operation) || !operation.updateOne) {
            return false;
          }

          return (operation.updateOne.filter as { _id?: string })._id === 'invoice:2:2';
        });

        if (shouldFail && hasFailingOp) {
          shouldFail = false;
          throw new Error('injected dedupe failure');
        }

        return dedupeCollection.bulkWrite(...args);
      }
    };

    const store = new MongoProjectionStore<Record<string, unknown>>({
      collection,
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: failingDedupeCollection,
      mongoClient: createFakeMongoClient()
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
              fullDocument: { total: 1 },
              checkpoint: { sequence: 1 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:1:1', checkpoint: { sequence: 1 } }]
          }
        },
        {
          routingKeySource: 'invoice-summary:doc-2',
          documents: [
            {
              documentId: 'doc-2',
              mode: 'full',
              fullDocument: { total: 2 },
              checkpoint: { sequence: 2 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:2:2', checkpoint: { sequence: 2 } }]
          }
        }
      ]
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.failedAtIndex).toBe(1);
      expect(result.reason).toBe('injected dedupe failure');
      expect(result.failure).toEqual({
        category: 'transient',
        code: 'write-failed',
        message: 'injected dedupe failure',
        retryable: true
      });
    }

    expect(await store.load('doc-1')).toBeNull();
    expect(await store.load('doc-2')).toBeNull();
    expect(await store.getDedupeCheckpoint('invoice:1:1')).toBeNull();
  });
});
