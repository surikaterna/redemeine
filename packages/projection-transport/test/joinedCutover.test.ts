import { describe, expect, it } from '@jest/globals';
import type { ClientSession, Collection, Document } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest, validateApproval, verifyInitialLinks, type JoinedApproval,
  type JoinedInventory } from '../src/joinedCutover';

const hash = `sha256:${'a'.repeat(64)}` as const;
const manifest: ProjectionQueueRegistryManifest = { version: 1, manifestId: hash, queueId: 'queue-A', registryGeneration: 'g1',
  identity: { version: 1, normalizedDefinitionRegistryDigest: hash, normalizedRuntimeConfigurationDigest: hash,
    executableCodeArtifactDigest: hash }, sourceStartAnchors: {}, definitions: [
    { projectionName: 'A', generation: 'g1', definitionHash: hash, sourceSelectors: ['Order'], joined: true }
  ] };

function fixture() {
  const now = new Date().toISOString();
  const rows = new Map<string, Document>([['A\u0000g1\u0000Order\u0000one', {
    _id: 'A\u0000g1\u0000Order\u0000one', aggregateType: 'Order', aggregateId: 'one',
    targetDocId: 'target', createdAt: now, v2Revision: 0 }]]);
  const docs = new Map<string, Document>([['target', { _id: 'target', state: { count: 1 } }]]);
  const links = { dbName: 'projection', collectionName: 'A_links', find: () => ({
    toArray: async () => [...rows.values()].sort((left, right) => String(left._id).localeCompare(String(right._id))) }) } as unknown as
    Collection<Document & { _id: string }>;
  const documents = { dbName: 'projection', collectionName: 'A_documents',
    findOne: async ({ _id }: { _id: string }) => docs.get(_id) ?? null } as unknown as Collection<Document & { _id: string }>;
  const item: JoinedInventory = { projectionName: 'A', generation: 'g1', links, documents };
  const draft = { _id: 'joined_approval:queue-A', kind: 'joined_approval' as const, queueBindingId: 'queue-A',
    manifestId: hash, registryGeneration: 'g1', approvalNamespace: 'projection.joined_approvals',
    transportNamespace: 'projection.A_transport',
    approvedBy: 'operator', approvedAt: now, inventories: [{ projectionName: 'A', generation: 'g1',
      linkNamespace: 'projection.A_links', documentNamespace: 'projection.A_documents',
      maxLinkRows: 3, expected: [{ aggregateType: 'Order', aggregateId: 'one', targetDocId: 'target' }] }] };
  const approval: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
  return { rows, docs, item, approval };
}

describe('durable joined cutover approval', () => {
  it('requires separately provisioned exact scope, database/collections and digest', async () => {
    const { item, approval } = fixture();
    const namespace = 'projection.joined_approvals';
    expect(() => validateApproval(manifest, null, [item], 'projection.A_transport', namespace)).toThrow();
    expect(() => validateApproval(manifest, approval, [], 'projection.A_transport', namespace)).toThrow();
    expect(() => validateApproval(manifest, approval, [item], 'projection.wrong', namespace)).toThrow();
    expect(() => validateApproval(manifest, { ...approval, digest: hash }, [item], 'projection.A_transport', namespace)).toThrow();
    expect(() => validateApproval(manifest, approval, [{ ...item, links: {
      ...item.links, dbName: 'projection', collectionName: 'other_links' } as JoinedInventory['links'] }],
    'projection.A_transport', namespace)).toThrow();
    validateApproval(manifest, approval, [item], 'projection.A_transport', namespace);
    await expect(verifyInitialLinks(approval.inventories[0]!, item, {} as ClientSession)).resolves.toBeUndefined();
    const underBound = { ...approval, inventories: [{ ...approval.inventories[0]!, maxLinkRows: 0 }] };
    expect(() => validateApproval(manifest, { ...underBound, digest: approvalDigest(underBound) }, [item],
      'projection.A_transport', namespace)).toThrow('bound');
  });

  it('rejects unscoped ghosts, unknown scoped, malformed, missing, wrong target and bounded overflow', async () => {
    const { rows, docs, item, approval } = fixture();
    const verify = () => verifyInitialLinks(approval.inventories[0]!, item, {} as ClientSession);
    rows.set('Order:one', { _id: 'Order:one', aggregateType: 'Order', aggregateId: 'one',
      targetDocId: 'target', createdAt: new Date().toISOString() });
    await expect(verify()).rejects.toThrow('differs');
    rows.delete('Order:one');
    rows.set('other\u0000g2\u0000Order\u0000one', { _id: 'other\u0000g2\u0000Order\u0000one' });
    await expect(verify()).rejects.toThrow('differs');
    rows.delete('other\u0000g2\u0000Order\u0000one');
    rows.set('Order:extra', { _id: 'Order:extra' });
    await expect(verify()).rejects.toThrow('differs');
    rows.set('Order:more', { _id: 'Order:more' });
    rows.set('Order:overflow', { _id: 'Order:overflow' });
    await expect(verify()).rejects.toThrow('bounded');
    rows.delete('Order:more'); rows.delete('Order:extra'); rows.delete('Order:overflow');
    const scoped = rows.get('A\u0000g1\u0000Order\u0000one')!;
    rows.delete('A\u0000g1\u0000Order\u0000one');
    await expect(verify()).rejects.toThrow('differs');
    rows.set('A\u0000g1\u0000Order\u0000one', { ...scoped, aggregateType: 'Wrong' });
    await expect(verify()).rejects.toThrow('conflicting');
    rows.set('A\u0000g1\u0000Order\u0000one', { ...scoped, targetDocId: null });
    await expect(verify()).rejects.toThrow('conflicting');
    rows.set('A\u0000g1\u0000Order\u0000one', scoped);
    docs.delete('target');
    await expect(verify()).rejects.toThrow('target');
    docs.set('target', { _id: 'target', state: {}, tombstone: true });
    await expect(verify()).rejects.toThrow('target');
  });

  it('requires explicit attested approval and an empty new collection for zero initial links', async () => {
    const { rows, item, approval } = fixture();
    const namespace = 'projection.joined_approvals';
    const unapproved = { ...approval, inventories: [{ ...approval.inventories[0]!, expected: [], maxLinkRows: 0 }] };
    expect(() => validateApproval(manifest, { ...unapproved, digest: approvalDigest(unapproved) }, [item],
      'projection.A_transport', namespace)).toThrow();
    const draft = { ...unapproved, inventories: [{ ...unapproved.inventories[0]!, knownEmpty: true as const,
      emptyInventoryReference: 'reviewed projection A join rules and domain source inventory' }] };
    const empty: JoinedApproval = { ...draft, digest: approvalDigest(draft) };
    validateApproval(manifest, empty, [item], 'projection.A_transport', namespace);
    await expect(verifyInitialLinks(empty.inventories[0]!, item, {} as ClientSession)).rejects.toThrow('bounded');
    rows.clear();
    await expect(verifyInitialLinks(empty.inventories[0]!, item, {} as ClientSession)).resolves.toBeUndefined();
  });
});
