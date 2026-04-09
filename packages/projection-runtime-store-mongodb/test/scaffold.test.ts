import { describe, expect, test } from 'bun:test';
import { MongoProjectionStore } from '../src/index';
import { createProjectionDedupeCollection, createProjectionDocumentCollection, createProjectionLinkCollection } from './mocks';

describe('projection-runtime-store-mongodb scaffold', () => {
  test('provides functional store implementation', async () => {
    const store = new MongoProjectionStore({
      collection: createProjectionDocumentCollection(),
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: createProjectionDedupeCollection()
    });
    await expect(store.load('doc-1')).resolves.toBeNull();
  });
});
