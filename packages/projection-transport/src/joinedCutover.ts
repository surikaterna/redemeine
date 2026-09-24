import { createHash } from 'node:crypto';
import type { ClientSession, Collection, Document } from 'mongodb';
import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';

export interface JoinedLinkTuple {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly targetDocId: string;
}

export interface JoinedInventory {
  readonly projectionName: string;
  readonly generation: string;
  readonly links: Collection<Document & { _id: string }>;
  readonly documents: Collection<Document & { _id: string }>;
}

export interface ApprovedJoinedInventory {
  readonly projectionName: string;
  readonly generation: string;
  readonly linkNamespace: string;
  readonly documentNamespace: string;
  readonly expected: readonly JoinedLinkTuple[];
  readonly maxLinkRows: number;
}

export interface JoinedApproval extends Document {
  readonly _id: string;
  readonly kind: 'joined_approval';
  readonly queueBindingId: string;
  readonly manifestId: string;
  readonly registryGeneration: string;
  readonly approvalNamespace: string;
  readonly transportNamespace: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly inventories: readonly ApprovedJoinedInventory[];
  readonly digest: string;
}

export function approvalDigest(record: Omit<JoinedApproval, 'digest'>): string {
  const { _id, kind, queueBindingId, manifestId, registryGeneration, approvalNamespace, transportNamespace,
    approvedBy, approvedAt, inventories } = record;
  return `sha256:${createHash('sha256').update(JSON.stringify({ _id, kind, queueBindingId, manifestId,
    registryGeneration, approvalNamespace, transportNamespace, approvedBy, approvedAt, inventories })).digest('hex')}`;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

export function collectionNamespace(collection: Pick<Collection<Document>, 'dbName' | 'collectionName'>): string {
  if (!collection.dbName || !collection.collectionName || collection.dbName.includes('.')
    || collection.collectionName.includes('.')) throw new Error('Invalid Mongo collection namespace.');
  return `${collection.dbName}.${collection.collectionName}`;
}

export function validateApproval(manifest: ProjectionQueueRegistryManifest, record: JoinedApproval | null,
  resources: readonly JoinedInventory[], transportNamespace: string,
  approvalNamespace: string): asserts record is JoinedApproval {
  const definitions = manifest.definitions.filter((entry) => entry.joined === true);
  if (!record || !exactKeys(record, ['_id', 'kind', 'queueBindingId', 'manifestId', 'registryGeneration',
    'approvalNamespace', 'transportNamespace',
    'approvedBy', 'approvedAt', 'inventories', 'digest']) || record.kind !== 'joined_approval'
    || record._id !== `joined_approval:${manifest.queueId}` || record.queueBindingId !== manifest.queueId
    || record.manifestId !== manifest.manifestId || record.registryGeneration !== manifest.registryGeneration
    || record.transportNamespace !== transportNamespace || record.approvalNamespace !== approvalNamespace
    || approvalNamespace === transportNamespace
    || typeof record.approvedBy !== 'string' || !record.approvedBy || !isIsoInstant(record.approvedAt)
    || !Array.isArray(record.inventories)
    || record.inventories.length !== definitions.length || resources.length !== definitions.length
    || record.digest !== approvalDigest(record) || !transportNamespace) throw new Error('Invalid durable joined approval.');
  const scopes = new Set<string>();
  for (const [index, item] of record.inventories.entries()) {
    const definition = definitions[index];
    const resource = resources[index];
    if (!exactKeys(item, ['projectionName', 'generation', 'linkNamespace', 'documentNamespace', 'expected', 'maxLinkRows'])
      || !definition || !resource || item.projectionName !== definition.projectionName
      || item.generation !== definition.generation || item.projectionName !== resource.projectionName
      || item.generation !== resource.generation || item.linkNamespace !== collectionNamespace(resource.links)
      || item.documentNamespace !== collectionNamespace(resource.documents)
      || !item.linkNamespace.startsWith(`${resource.links.dbName}.`)
      || resource.links.dbName !== transportNamespace.slice(0, transportNamespace.lastIndexOf('.'))
      || resource.links.dbName !== approvalNamespace.slice(0, approvalNamespace.lastIndexOf('.'))
      || resource.documents.dbName !== resource.links.dbName
      || item.linkNamespace === item.documentNamespace || !Array.isArray(item.expected)
      || !Number.isSafeInteger(item.maxLinkRows) || item.maxLinkRows < item.expected.length * 2
      || item.maxLinkRows > 100_000) throw new Error('Joined approval scope, namespace or bound mismatch.');
    const scope = `${item.projectionName}\u0000${item.generation}`;
    if (scopes.has(scope)) throw new Error('Duplicate joined approval scope.');
    scopes.add(scope);
    const keys = item.expected.map((tuple: JoinedLinkTuple) => {
      if (!exactKeys(tuple, ['aggregateType', 'aggregateId', 'targetDocId'])
        || ![tuple.aggregateType, tuple.aggregateId, tuple.targetDocId].every((v) => typeof v === 'string'
          && v.length > 0 && !v.includes('\u0000'))) throw new Error('Invalid approved joined tuple.');
      return `${tuple.aggregateType}:${tuple.aggregateId}`;
    });
    if (new Set(keys).size !== keys.length) throw new Error('Ambiguous legacy joined inventory.');
  }
  const namespaces = record.inventories.flatMap((item) => [item.linkNamespace, item.documentNamespace]);
  if (new Set(namespaces).size !== namespaces.length || namespaces.includes(transportNamespace)
    || namespaces.includes(approvalNamespace)) {
    throw new Error('Joined collections must be physically isolated.');
  }
}

function validLink(row: Document, tuple: JoinedLinkTuple, scoped: boolean): boolean {
  const fields = ['_id', 'aggregateType', 'aggregateId', 'targetDocId', 'createdAt', ...(scoped ? ['v2Revision'] : [])];
  return exactKeys(row, fields) && row.aggregateType === tuple.aggregateType && row.aggregateId === tuple.aggregateId
    && row.targetDocId === tuple.targetDocId && isIsoInstant(row.createdAt) && (!scoped || row.v2Revision === 0);
}

export async function verifyInitialLinks(item: ApprovedJoinedInventory, resource: JoinedInventory,
  session: ClientSession): Promise<void> {
  const rows = await resource.links.find({}, { sort: { _id: 1 }, hint: { _id: 1 }, limit: item.maxLinkRows + 1,
    session }).toArray();
  if (rows.length > item.maxLinkRows) throw new Error('Joined inventory exceeds bounded collection scan.');
  const expected = new Map<string, { tuple: JoinedLinkTuple; scoped: boolean }>();
  for (const tuple of item.expected) {
    expected.set(`${tuple.aggregateType}:${tuple.aggregateId}`, { tuple, scoped: false });
    expected.set([item.projectionName, item.generation, tuple.aggregateType, tuple.aggregateId].join('\u0000'),
      { tuple, scoped: true });
  }
  if (rows.length !== expected.size) throw new Error('Joined collection differs from approved complete inventory.');
  for (const row of rows) {
    const match = expected.get(row._id);
    if (!match || !validLink(row, match.tuple, match.scoped)) {
      throw new Error('Unexpected or conflicting joined collection row.');
    }
    expected.delete(row._id);
  }
  if (expected.size) throw new Error('Missing approved joined link.');
  for (const targetDocId of new Set(item.expected.map((tuple) => tuple.targetDocId))) {
    const target = await resource.documents.findOne({ _id: targetDocId }, { session });
    if (!target || target.state == null || target.deleted === true || target.tombstone === true) {
      throw new Error('Joined target document missing or tombstoned.');
    }
  }
}
