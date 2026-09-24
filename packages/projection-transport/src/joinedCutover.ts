import { createHash } from 'node:crypto';
import type { Collection, Document } from 'mongodb';
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
  readonly expected: readonly JoinedLinkTuple[];
  readonly maxLegacyRows: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** sha256 of JSON.stringify({queueId,manifestId,registryGeneration,projectionName,generation,expected,maxLegacyRows,approvedBy,approvedAt}). */
  readonly approvedDigest: string;
}

export function inventoryDigest(manifest: ProjectionQueueRegistryManifest,
  inventory: Pick<JoinedInventory, 'projectionName' | 'generation' | 'expected' | 'maxLegacyRows' | 'approvedBy' | 'approvedAt'>): string {
  const { projectionName, generation, expected, maxLegacyRows, approvedBy, approvedAt } = inventory;
  return `sha256:${createHash('sha256').update(JSON.stringify({ queueId: manifest.queueId,
    manifestId: manifest.manifestId, registryGeneration: manifest.registryGeneration,
    projectionName, generation, expected, maxLegacyRows, approvedBy, approvedAt })).digest('hex')}`;
}

export function validateInventories(manifest: ProjectionQueueRegistryManifest, inventories: readonly JoinedInventory[]): void {
  const joined = manifest.definitions.filter((definition) => definition.joined === true);
  if (inventories.length !== joined.length) throw new Error('Missing or unexpected joined cutover inventory.');
  const scopes = new Set<string>();
  for (const item of inventories) {
    const scope = `${item.projectionName}\u0000${item.generation}`;
    if (scopes.has(scope) || !joined.some((definition) => definition.projectionName === item.projectionName
      && definition.generation === item.generation)) throw new Error('Ambiguous joined inventory scope.');
    scopes.add(scope);
    if (!item.approvedBy || !item.approvedAt || !Number.isSafeInteger(item.maxLegacyRows)
      || item.maxLegacyRows < 0 || item.expected.length > item.maxLegacyRows
      || item.approvedDigest !== inventoryDigest(manifest, item)) throw new Error('Joined inventory approval or bound is invalid.');
    const keys = item.expected.map(({ aggregateType, aggregateId, targetDocId }) => {
      if (![aggregateType, aggregateId, targetDocId].every((value) => typeof value === 'string' && value.length > 0
        && !value.includes('\u0000'))) throw new Error('Invalid joined inventory tuple.');
      return `${aggregateType}\u0000${aggregateId}`;
    });
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate joined inventory tuple.');
  }
}

export async function verifyInitialLinks(item: JoinedInventory): Promise<void> {
  const legacy = await item.links.find({ _id: { $regex: '^[^\\x00]+$' } },
    { projection: { _id: 1, targetDocId: 1 }, limit: item.maxLegacyRows + 1 }).toArray();
  if (legacy.length > item.maxLegacyRows) throw new Error('Joined legacy inventory exceeds bounded scan.');
  const expected = new Map(item.expected.map((row) => [`${row.aggregateType}:${row.aggregateId}`, row]));
  const found = new Set<string>();
  for (const row of legacy) {
    if (typeof row._id !== 'string' || row._id.includes('\u0000')) continue;
    const match = expected.get(row._id);
    if (!match || found.has(row._id) || row.targetDocId !== match.targetDocId) {
      throw new Error('Unexpected or conflicting legacy joined link.');
    }
    found.add(row._id);
  }
  if (found.size !== expected.size) throw new Error('Approved joined inventory differs from legacy links.');
  for (const tuple of item.expected) {
    const _id = [item.projectionName, item.generation, tuple.aggregateType, tuple.aggregateId].join('\u0000');
    const scoped = await item.links.findOne({ _id });
    if (!scoped || scoped.aggregateType !== tuple.aggregateType || scoped.aggregateId !== tuple.aggregateId
      || scoped.targetDocId !== tuple.targetDocId || scoped.v2Revision !== 0
      || typeof scoped.createdAt !== 'string' || !Number.isFinite(Date.parse(scoped.createdAt))) {
      throw new Error('Missing, tombstoned or conflicting scoped joined link.');
    }
    const target = await item.documents.findOne({ _id: tuple.targetDocId });
    if (!target || target.deleted === true || target.tombstone === true || target.state == null) {
      throw new Error('Joined target document missing or tombstoned.');
    }
  }
}
