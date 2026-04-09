import { describe, expect, test } from '@jest/globals';
import type { IProjectionLinkStore } from '../src/contracts';
import { MongoProjectionLinkStore, toLinkId } from '../src';
import { createProjectionLinkCollection } from './mocks';

describe('MongoProjectionLinkStore', () => {
  test('implements IProjectionLinkStore contract', () => {
    const collection = createProjectionLinkCollection();
    const store: IProjectionLinkStore = new MongoProjectionLinkStore({ collection });

    expect(typeof store.addLink).toBe('function');
    expect(typeof store.resolveTarget).toBe('function');
  });

  test('addLink resolves aggregate mapping', async () => {
    const collection = createProjectionLinkCollection();
    const now = () => '2026-04-09T00:00:00.000Z';
    const store = new MongoProjectionLinkStore({ collection, now });

    await store.addLink('invoice', 'inv-1', 'doc-1');

    expect(await store.resolveTarget('invoice', 'inv-1')).toBe('doc-1');
    expect(collection.snapshot()).toEqual([
      {
        _id: 'invoice:inv-1',
        aggregateType: 'invoice',
        aggregateId: 'inv-1',
        targetDocId: 'doc-1',
        createdAt: '2026-04-09T00:00:00.000Z'
      }
    ]);
  });

  test('addLink keeps first-writer-wins semantics', async () => {
    const collection = createProjectionLinkCollection();
    const store = new MongoProjectionLinkStore({ collection });

    await store.addLink('invoice', 'inv-2', 'doc-old');
    await store.addLink('invoice', 'inv-2', 'doc-new');

    expect(await store.resolveTarget('invoice', 'inv-2')).toBe('doc-old');
    expect(collection.snapshot()).toHaveLength(1);
  });

  test('removeLinksForTarget deletes all matching links', async () => {
    const collection = createProjectionLinkCollection();
    const store = new MongoProjectionLinkStore({ collection });

    await store.addLink('invoice', 'inv-3', 'doc-z');
    await store.addLink('shipment', 'ship-1', 'doc-z');
    await store.addLink('shipment', 'ship-2', 'doc-other');

    await store.removeLinksForTarget?.('doc-z');

    expect(await store.resolveTarget('invoice', 'inv-3')).toBeNull();
    expect(await store.resolveTarget('shipment', 'ship-1')).toBeNull();
    expect(await store.resolveTarget('shipment', 'ship-2')).toBe('doc-other');
  });

  test('toLinkId builds deterministic key', () => {
    expect(toLinkId('invoice', '123')).toBe('invoice:123');
  });
});
