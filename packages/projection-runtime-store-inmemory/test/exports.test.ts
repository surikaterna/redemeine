import { describe, expect, test } from 'bun:test';
import { InMemoryProjectionLinkStore, InMemoryProjectionStore } from '../src/index';

describe('projection-runtime-store-inmemory exports', () => {
  test('constructs store implementations', () => {
    const store = new InMemoryProjectionStore<{ value: number }>();
    const links = new InMemoryProjectionLinkStore();

    expect(store).toBeTruthy();
    expect(links).toBeTruthy();
  });
});
