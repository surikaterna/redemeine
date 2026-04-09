import { describe, expect, test } from 'bun:test';
import { MongoProjectionStore } from '../src/index';

describe('projection-runtime-store-mongodb scaffold', () => {
  test('throws not implemented on load', async () => {
    const store = new MongoProjectionStore();
    await expect(store.load('doc-1')).rejects.toThrow('scaffold-only');
  });
});
