import { describe, expect, test, beforeEach } from '@jest/globals';
import { InMemoryProjectionStore, Checkpoint } from '../../src/projections';

describe('InMemoryProjectionStore', () => {
  let store: InMemoryProjectionStore<{ count: number }>;

  beforeEach(() => {
    store = new InMemoryProjectionStore();
  });

  test('load returns null for non-existent document', async () => {
    const result = await store.load('non-existent');
    expect(result).toBeNull();
  });

  test('save and load work correctly', async () => {
    const id = 'test-doc-1';
    const state = { count: 42 };
    const checkpoint: Checkpoint = { sequence: 10, timestamp: Date.now() };

    await store.save(id, state, checkpoint);
    const loaded = await store.load(id);

    expect(loaded).toEqual({ count: 42 });
  });

  test('atomic save - state and checkpoint are updated together', async () => {
    const id = 'atomic-test';
    const state = { count: 100 };
    const checkpoint: Checkpoint = { sequence: 25 };

    await store.save(id, state, checkpoint);

    // Load state
    const loadedState = await store.load(id);
    expect(loadedState).toEqual({ count: 100 });

    // Load checkpoint - getCheckpoint is a helper method
    const loadedCheckpoint = await store.getCheckpoint(id);
    expect(loadedCheckpoint).toEqual({ sequence: 25 });
  });

  test('getCheckpoint returns null for non-existent document', async () => {
    const checkpoint = await store.getCheckpoint('non-existent');
    expect(checkpoint).toBeNull();
  });

  test('exists returns false for non-existent document', async () => {
    const exists = await store.exists('non-existent');
    expect(exists).toBe(false);
  });

  test('exists returns true for saved document', async () => {
    const id = 'exists-test';
    
    const before = await store.exists(id);
    expect(before).toBe(false);

    await store.save(id, { count: 1 }, { sequence: 1 });

    const after = await store.exists(id);
    expect(after).toBe(true);
  });

  test('delete removes document', async () => {
    const id = 'delete-test';

    await store.save(id, { count: 1 }, { sequence: 1 });
    expect(await store.load(id)).not.toBeNull();

    await store.delete(id);
    expect(await store.load(id)).toBeNull();
  });

  test('delete on non-existent document does not throw', async () => {
    // Should not throw - verify by calling and not getting an error
    const promise = store.delete('non-existent');
    await expect(promise).resolves.toBeUndefined();
  });

  test('checkpoint is updated on subsequent saves', async () => {
    const id = 'checkpoint-update-test';

    await store.save(id, { count: 1 }, { sequence: 1 });
    await store.save(id, { count: 2 }, { sequence: 5 });
    await store.save(id, { count: 3 }, { sequence: 10 });

    const checkpoint = await store.getCheckpoint(id);
    expect(checkpoint?.sequence).toBe(10);

    const state = await store.load(id);
    expect(state?.count).toBe(3);
  });

  test('load returns latest state after multiple saves', async () => {
    const id = 'multi-save-test';

    await store.save(id, { count: 1 }, { sequence: 1 });
    await store.save(id, { count: 2 }, { sequence: 2 });
    await store.save(id, { count: 3 }, { sequence: 3 });

    const loaded = await store.load(id);
    expect(loaded).toEqual({ count: 3 });
  });

  test('clear removes all documents', async () => {
    await store.save('doc1', { count: 1 }, { sequence: 1 });
    await store.save('doc2', { count: 2 }, { sequence: 1 });

    store.clear();

    expect(await store.load('doc1')).toBeNull();
    expect(await store.load('doc2')).toBeNull();
  });

  test('getAll returns all stored documents', async () => {
    await store.save('doc1', { count: 10 }, { sequence: 1 });
    await store.save('doc2', { count: 20 }, { sequence: 2 });

    const all = store.getAll();
    
    expect(all.size).toBe(2);
    expect(all.get('doc1')?.state).toEqual({ count: 10 });
    expect(all.get('doc2')?.state).toEqual({ count: 20 });
  });

  test('getAll returns a copy (not reference to internal map)', async () => {
    await store.save('doc1', { count: 1 }, { sequence: 1 });

    const all = store.getAll();
    all.clear();

    // Original should be unaffected
    expect((await store.load('doc1'))?.count).toBe(1);
  });

  test('stores updatedAt timestamp', async () => {
    const id = 'timestamp-test';
    await store.save(id, { count: 1 }, { sequence: 1 });

    const doc = store.getAll().get(id);
    expect(doc?.updatedAt).toBeDefined();
    expect(typeof doc?.updatedAt).toBe('string');
  });

  test('supports different state types', async () => {
    const stringStore = new InMemoryProjectionStore<string>();
    await stringStore.save('s', 'hello', { sequence: 1 });
    expect(await stringStore.load('s')).toBe('hello');

    const arrayStore = new InMemoryProjectionStore<string[]>();
    await arrayStore.save('a', ['one', 'two'], { sequence: 1 });
    expect(await arrayStore.load('a')).toEqual(['one', 'two']);

    const complexStore = new InMemoryProjectionStore<{ nested: { deep: number } }>();
    await complexStore.save('c', { nested: { deep: 42 } }, { sequence: 1 });
    expect(await complexStore.load('c')).toEqual({ nested: { deep: 42 } });
  });

  test('handles null state correctly', async () => {
    const nullStore = new InMemoryProjectionStore<null>();
    await nullStore.save('null-doc', null, { sequence: 1 });
    
    const loaded = await nullStore.load('null-doc');
    expect(loaded).toBeNull();
  });

  test('handles undefined state correctly', async () => {
    const undefinedStore = new InMemoryProjectionStore<undefined>();
    await undefinedStore.save('undefined-doc', undefined, { sequence: 1 });
    
    const loaded = await undefinedStore.load('undefined-doc');
    expect(loaded).toBeUndefined();
  });

  test('multiple independent stores are isolated', async () => {
    const store1 = new InMemoryProjectionStore<{ id: string }>();
    const store2 = new InMemoryProjectionStore<{ id: string }>();

    await store1.save('shared-id', { id: 'store1' }, { sequence: 1 });
    await store2.save('shared-id', { id: 'store2' }, { sequence: 1 });

    expect(await store1.load('shared-id')).toEqual({ id: 'store1' });
    expect(await store2.load('shared-id')).toEqual({ id: 'store2' });
  });
});
