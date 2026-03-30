import { describe, expect, test } from '@jest/globals';
import type { IProjectionStore, Checkpoint } from '../src/projections';

// Mock implementation for testing interface contract
class MockProjectionStore<TState> implements IProjectionStore<TState> {
  private store: Map<string, { state: TState; cursor: Checkpoint }> = new Map();

  async load(id: string): Promise<TState | null> {
    const entry = this.store.get(id);
    return entry ? entry.state : null;
  }

  async save(id: string, state: TState, cursor: Checkpoint): Promise<void> {
    // Simulate atomic commit
    this.store.set(id, { state, cursor });
  }

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

describe('IProjectionStore interface contract', () => {
  test('load returns null for non-existent document', async () => {
    const store = new MockProjectionStore<{ count: number }>();
    const result = await store.load('non-existent');
    expect(result).toBeNull();
  });

  test('save and load work atomically with checkpoint', async () => {
    const store = new MockProjectionStore<{ count: number }>();
    const id = 'test-doc-1';
    const state = { count: 42 };
    const checkpoint: Checkpoint = { sequence: 10, timestamp: Date.now() };

    await store.save(id, state, checkpoint);
    const loaded = await store.load(id);

    expect(loaded).toEqual({ count: 42 });
  });

  test('exists returns true for saved document', async () => {
    const store = new MockProjectionStore<{ value: string }>();
    const id = 'exists-test';

    const before = await store.exists!(id);
    expect(before).toBe(false);

    await store.save(id, { value: 'test' }, { sequence: 1 });

    const after = await store.exists!(id);
    expect(after).toBe(true);
  });

  test('delete removes document', async () => {
    const store = new MockProjectionStore<{ data: unknown }>();
    const id = 'delete-test';

    await store.save(id, { data: 'to-delete' }, { sequence: 1 });
    expect(await store.load(id)).not.toBeNull();

    await store.delete!(id);
    expect(await store.load(id)).toBeNull();
  });

  test('checkpoint is persisted alongside state', async () => {
    const store = new MockProjectionStore<{ items: string[] }>();
    const id = 'checkpoint-test';

    // Verify internal state captures checkpoint
    await store.save(id, { items: ['a', 'b'] }, { sequence: 5 });

    // The store should have the checkpoint available (internal verification)
    const mockStore = store as unknown as { store: Map<string, { state: unknown; cursor: Checkpoint }> };
    const entry = mockStore.store.get(id);

    expect(entry).toBeDefined();
    expect(entry!.cursor.sequence).toBe(5);
  });

  test('load returns latest state after multiple saves', async () => {
    const store = new MockProjectionStore<{ version: number }>();
    const id = 'multi-save-test';

    await store.save(id, { version: 1 }, { sequence: 1 });
    await store.save(id, { version: 2 }, { sequence: 2 });
    await store.save(id, { version: 3 }, { sequence: 3 });

    const loaded = await store.load(id);
    expect(loaded).toEqual({ version: 3 });
  });

  test('interface type checking - methods return Promises', async () => {
    const store = new MockProjectionStore<unknown>();

    // Verify return types are Promises (compile-time check via usage)
    const loadResult = store.load('any');
    const saveResult = store.save('any', {} as unknown, { sequence: 0 });

    expect(loadResult).toBeInstanceOf(Promise);
    expect(saveResult).toBeInstanceOf(Promise);

    await Promise.all([loadResult, saveResult]);
  });

  test('optional methods exist when implemented', async () => {
    const store = new MockProjectionStore<unknown>();

    // exists and delete are optional but implemented in MockProjectionStore
    expect(typeof store.exists).toBe('function');
    expect(typeof store.delete).toBe('function');
  });

  test('generic type parameter allows any state shape', async () => {
    // Test with various state shapes to verify generic works
    const stringStore = new MockProjectionStore<string>();
    const arrayStore = new MockProjectionStore<string[]>;
    const complexStore = new MockProjectionStore<{ nested: { deep: number[] }; date: Date }>();

    await stringStore.save('s', 'hello', { sequence: 1 });
    await arrayStore.save('a', ['one', 'two'], { sequence: 1 });
    await complexStore.save('c', { nested: { deep: [1, 2, 3] }, date: new Date() }, { sequence: 1 });

    expect(await stringStore.load('s')).toBe('hello');
    expect(await arrayStore.load('a')).toEqual(['one', 'two']);
    expect(await complexStore.load('c')).toEqual({ nested: { deep: [1, 2, 3] }, date: expect.any(Date) });
  });
});
