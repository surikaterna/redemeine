import { checkedJoinMembershipKey, validateJoinTargetSet } from '@redemeine/projection-runtime-core';
import type { ClientSession, Document } from 'mongodb';
import type { JoinedInventory } from './joinedCutover';

export interface ApprovedJoinedSet {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Sorted unique edges; [] represents an explicit tombstone, not an omitted row. */
  readonly targetDocumentIds: readonly string[];
}

export interface ApprovedJoinedSetInventory {
  readonly format: 'set-v1';
  readonly projectionName: string;
  readonly generation: string;
  readonly linkNamespace: string;
  readonly documentNamespace: string;
  readonly expectedSets: readonly ApprovedJoinedSet[];
  readonly maxLinkRows: number;
  readonly maxEdges: number;
  readonly maxTargetBytes: number;
  readonly knownEmpty?: true;
  readonly emptyInventoryReference?: string;
}

export function joinedMembershipSeedRow(scope: Pick<ApprovedJoinedSetInventory, 'projectionName' | 'generation'>,
  set: ApprovedJoinedSet) {
  validateJoinTargetSet(set.targetDocumentIds);
  const { aggregateType, aggregateId, targetDocumentIds } = set;
  return { _id: checkedJoinMembershipKey(scope.projectionName, scope.generation, aggregateType, aggregateId),
    format: 'set-v1' as const, aggregateType, aggregateId, targetDocumentIds: [...targetDocumentIds], revision: 0 };
}

function hasKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function withinBound(value: number, count: number, max: number): boolean {
  return Number.isSafeInteger(value) && count <= value && value <= max;
}

export function validateJoinedSetInventory(item: ApprovedJoinedSetInventory): void {
  const fields = ['format', 'projectionName', 'generation', 'linkNamespace', 'documentNamespace',
    'expectedSets', 'maxLinkRows', 'maxEdges', 'maxTargetBytes'];
  if (!Array.isArray(item.expectedSets)) throw new Error('Missing approved membership sets.');
  const empty = item.expectedSets.every((row: ApprovedJoinedSet) => Array.isArray(row?.targetDocumentIds)
    && row.targetDocumentIds.length === 0);
  if (!hasKeys(item, empty ? [...fields, 'knownEmpty', 'emptyInventoryReference'] : fields) || item.format !== 'set-v1'
    || (empty && (item.knownEmpty !== true || typeof item.emptyInventoryReference !== 'string' || !item.emptyInventoryReference.trim()))
    || !withinBound(item.maxLinkRows, item.expectedSets.length, 100_000)) throw new Error('Invalid approved membership inventory.');
  const keys = new Set<string>();
  let edges = 0;
  let bytes = 0;
  for (const row of item.expectedSets as readonly ApprovedJoinedSet[]) {
    if (!hasKeys(row, ['aggregateType', 'aggregateId', 'targetDocumentIds'])
      || ![row.aggregateType, row.aggregateId].every((value) => typeof value === 'string' && value.length > 0)) {
      throw new Error('Invalid approved membership set.');
    }
    const seed = joinedMembershipSeedRow(item, row);
    if (keys.has(seed._id)) throw new Error('Duplicate approved membership set.');
    keys.add(seed._id);
    edges += seed.targetDocumentIds.length;
    bytes += new TextEncoder().encode(JSON.stringify(seed)).byteLength;
    if (!withinBound(item.maxEdges, edges, 100_000) || !withinBound(item.maxTargetBytes, bytes, 32 * 1024 * 1024)) {
      throw new Error('Approved membership inventory exceeds edge or byte bound.');
    }
  }
  if (!withinBound(item.maxEdges, edges, 100_000) || !withinBound(item.maxTargetBytes, bytes, 32 * 1024 * 1024)) {
    throw new Error('Invalid approved membership inventory bounds.');
  }
}

function matchesSeed(row: Document, seed: ReturnType<typeof joinedMembershipSeedRow>): boolean {
  return hasKeys(row, Object.keys(seed)) && row.format === seed.format && row.revision === 0
    && row.aggregateType === seed.aggregateType && row.aggregateId === seed.aggregateId
    && Array.isArray(row.targetDocumentIds) && row.targetDocumentIds.length === seed.targetDocumentIds.length
    && seed.targetDocumentIds.every((id, index) => row.targetDocumentIds[index] === id);
}

export async function verifyInitialMembershipSets(item: ApprovedJoinedSetInventory, resource: JoinedInventory,
  session: ClientSession): Promise<void> {
  const seeds = item.expectedSets.map((row) => joinedMembershipSeedRow(item, row));
  const expected = new Map(seeds.map((row) => [row._id, row]));
  for await (const row of resource.links.find({}, { hint: { _id: 1 }, limit: item.maxLinkRows + 1, session })) {
    const seed = expected.get(row._id);
    if (!seed || !matchesSeed(row, seed)) throw new Error('Joined membership collection differs from approved complete inventory.');
    expected.delete(row._id);
  }
  if (expected.size) throw new Error('Missing approved membership set.');
  const targets = [...new Set(seeds.flatMap((row) => row.targetDocumentIds))];
  for (let offset = 0; offset < targets.length; offset += 256) {
    const chunk = targets.slice(offset, offset + 256);
    const rows = await resource.documents.find({ _id: { $in: chunk } }, { session }).toArray();
    if (rows.length !== chunk.length || rows.some((row) => row.state == null || row.deleted === true || row.tombstone === true)) {
      throw new Error('Joined target document missing or tombstoned.');
    }
  }
}
