import { describe, expect, it } from '@jest/globals';
import type { Collection, Document } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { inventoryDigest, validateInventories, verifyInitialLinks, type JoinedInventory } from '../src/joinedCutover';

const hash = `sha256:${'a'.repeat(64)}` as const;
const manifest: ProjectionQueueRegistryManifest = { version: 1, manifestId: hash, queueId: 'queue-A', registryGeneration: 'g1',
  identity: { version: 1, normalizedDefinitionRegistryDigest: hash, normalizedRuntimeConfigurationDigest: hash,
    executableCodeArtifactDigest: hash }, sourceStartAnchors: {}, definitions: [
    { projectionName: 'A', generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true }
  ] };

function fixture() {
  const rows = new Map<string, Record<string, unknown>>();
  const docs = new Map<string, Record<string, unknown>>([['target', { _id: 'target', state: { count: 1 } }]]);
  rows.set('Order:one', { _id: 'Order:one', targetDocId: 'target' });
  rows.set('A\u0000g1\u0000Order\u0000one', { _id: 'A\u0000g1\u0000Order\u0000one', aggregateType: 'Order',
    aggregateId: 'one', targetDocId: 'target', createdAt: new Date().toISOString(), v2Revision: 0 });
  const links = { find: () => ({ toArray: async () => [...rows.values()].filter((row) => !String(row._id).includes('\u0000')) }),
    findOne: async ({ _id }: { _id: string }) => rows.get(_id) ?? null } as unknown as Collection<Document & { _id: string }>;
  const documents = { findOne: async ({ _id }: { _id: string }) => docs.get(_id) ?? null } as unknown as
    Collection<Document & { _id: string }>;
  const draft = { projectionName: 'A', generation: 'g1', links, documents,
    expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }],
    maxLegacyRows: 2, approvedBy: 'operator', approvedAt: '2026-09-24T00:00:00Z' };
  const item: JoinedInventory = { ...draft, approvedDigest: inventoryDigest(manifest, draft) };
  return { rows, docs, item };
}

describe('joined cutover admission', () => {
  it('requires exact approved manifest inventory and strategy-independent scoped links', async () => {
    const { item } = fixture();
    expect(() => validateInventories(manifest, [])).toThrow('Missing');
    expect(() => validateInventories(manifest, [item, item])).toThrow();
    expect(() => validateInventories(manifest, [{ ...item, generation: 'g2' }])).toThrow();
    expect(() => validateInventories(manifest, [{ ...item, approvedDigest: hash }])).toThrow();
    validateInventories(manifest, [item]);
    await expect(verifyInitialLinks(item)).resolves.toBeUndefined();
  });

  it('rejects omission, wrong scoped target, tombstone, absent target, unexpected legacy key and bound overflow', async () => {
    const { item, rows, docs } = fixture();
    const scopedId = 'A\u0000g1\u0000Order\u0000one';
    rows.delete(scopedId);
    await expect(verifyInitialLinks(item)).rejects.toThrow('scoped');
    rows.set(scopedId, { _id: scopedId, targetDocId: 'wrong', v2Revision: 0, createdAt: new Date().toISOString() });
    await expect(verifyInitialLinks(item)).rejects.toThrow('scoped');
    rows.set(scopedId, { _id: scopedId, aggregateType: 'Order', aggregateId: 'one', targetDocId: null,
      v2Revision: 1, createdAt: new Date().toISOString() });
    await expect(verifyInitialLinks(item)).rejects.toThrow('scoped');
    rows.set(scopedId, { _id: scopedId, aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target',
      v2Revision: 0, createdAt: new Date().toISOString() });
    docs.delete('target');
    await expect(verifyInitialLinks(item)).rejects.toThrow('target');
    docs.set('target', { _id: 'target', state: {}, tombstone: true });
    await expect(verifyInitialLinks(item)).rejects.toThrow('target');
    rows.set('Order:extra', { _id: 'Order:extra', targetDocId: 'target' });
    await expect(verifyInitialLinks(item)).rejects.toThrow('legacy');
    rows.set('Order:more', { _id: 'Order:more', targetDocId: 'target' });
    await expect(verifyInitialLinks(item)).rejects.toThrow('bounded');
  });
});
