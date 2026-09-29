import { createHash } from 'node:crypto';
import { OwnerMismatchError, type OwnedNames } from './crashOwnership';

export interface MongoNames {
  readonly db: string;
  readonly sagaPartition: string;
  readonly sourcePartition: string;
  readonly sourceCollection: string;
}

export function validateMongoNames(names: MongoNames): void {
  if (!names.db || Buffer.byteLength(names.db) > 63 || names.db.includes('\0') || /[/\\."$*<>:|?]/.test(names.db)) {
    throw new TypeError('owned Mongo database name is invalid');
  }
  if ([names.sagaPartition, names.sourcePartition].some(partition =>
    !/^[a-zA-Z0-9_]{1,128}$/.test(partition)) ||
      names.sourceCollection !== `tw_${names.sourcePartition}_commits`) {
    throw new TypeError('owned Mongo partition or collection name is invalid');
  }
  for (const collection of [names.sourceCollection, `tw_${names.sagaPartition}_commits`, '__crash_owner']) {
    if (!collection || collection.startsWith('system.') || collection.includes('\0') ||
        Buffer.byteLength(`${names.db}.${collection}`) > 255) {
      throw new TypeError('owned Mongo collection namespace is invalid');
    }
  }
}

export function deriveOwnedNames(runId: string): { owned: OwnedNames; mongo: MongoNames; digest: string } {
  if (!/^[a-zA-Z0-9_]{1,100}$/.test(runId)) throw new TypeError('invalid isolated run identity');
  // An accidental 96-bit prefix collision is still stopped by exact DB absence preflight.
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 24);
  const mongo: MongoNames = { db: `sagacr_${digest}`, sagaPartition: `saga_${digest}`,
    sourcePartition: `source_${digest}`, sourceCollection: `tw_source_${digest}_commits` };
  const owned: OwnedNames = { db: mongo.db, vhost: `crash_${runId}`, user: `crash_${runId}` };
  validateMongoNames(mongo);
  for (const name of [owned.vhost, owned.user]) {
    if (Buffer.byteLength(name) > 255) throw new TypeError('owned Rabbit name is invalid');
  }
  return { owned, mongo, digest };
}

export interface UserOwnerEvidence { readonly tagShape: 'string' | 'array' | 'invalid'; readonly ownerMatch: boolean }

/** Only the precise monitoring+run-marker set grants deletion authority. */
export function inspectUserTags(value: unknown, marker: string): UserOwnerEvidence {
  const shape = typeof value === 'string' ? 'string' : Array.isArray(value) ? 'array' : 'invalid';
  const tags: readonly unknown[] | null = typeof value === 'string' ? value.split(',').map(tag => tag.trim()) :
    Array.isArray(value) ? value : null;
  const safe = tags !== null && tags.length === 2 && tags.every(tag =>
    typeof tag === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(tag));
  return { tagShape: shape, ownerMatch: safe && tags !== null && new Set(tags).size === 2 &&
    tags.includes('monitoring') && tags.includes(marker) };
}

export async function removeOwnedUser(marker: string, readTags: () => Promise<unknown | null>,
  remove: () => Promise<void>, absent: () => Promise<boolean>): Promise<'absent' | 'removed'> {
  const tags = await readTags();
  if (tags === null) return 'absent';
  if (!inspectUserTags(tags, marker).ownerMatch) throw new OwnerMismatchError();
  await remove();
  if (!await absent()) throw new Error('owned Rabbit user remains');
  return 'removed';
}
