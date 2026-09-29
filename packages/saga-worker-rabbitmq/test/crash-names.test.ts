import { describe, expect, it } from '@jest/globals';
import { deriveOwnedNames, inspectUserTags, removeOwnedUser, validateMongoNames } from '../integration/crashNames';
import { OwnedCrashScope, OwnerMismatchError, type OwnedOps } from '../integration/crashOwnership';

const marker = 'owned_crash_run';

describe('isolated Mongo namespace', () => {
  it('accepts a 63-byte database but refuses 64 bytes and oversized collection namespace', () => {
    const names = deriveOwnedNames(`wrdf_${'a'.repeat(70)}`).mongo;
    expect(() => validateMongoNames({ ...names, db: 'a'.repeat(63) })).not.toThrow();
    expect(() => validateMongoNames({ ...names, db: 'a'.repeat(64) })).toThrow('database');
    expect(() => validateMongoNames({ ...names, sourcePartition: 'a'.repeat(128),
      sourceCollection: `tw_${'a'.repeat(129)}_commits` })).toThrow('partition or collection');
  });

  it('hashes max-shaped distinct run IDs deterministically into short distinct names', () => {
    const first = deriveOwnedNames(`wrdf_${'a'.repeat(90)}`);
    const same = deriveOwnedNames(`wrdf_${'a'.repeat(90)}`);
    const next = deriveOwnedNames(`wrdf_${'a'.repeat(89)}b`);
    expect(first).toEqual(same);
    expect(first.owned.db).not.toBe(next.owned.db);
    expect(first.digest).toMatch(/^[0-9a-f]{24}$/);
    expect(Buffer.byteLength(first.owned.db)).toBeLessThanOrEqual(63);
    expect(first.mongo.sourceCollection).toBe(`tw_${first.mongo.sourcePartition}_commits`);
    expect(() => deriveOwnedNames('a'.repeat(101))).toThrow('run identity');
  });
});

describe('exact Rabbit user ownership tags', () => {
  it.each([`monitoring,${marker}`, ['monitoring', marker], ` ${marker},monitoring `])
  ('accepts only the expected two tags in either management shape', value => {
    expect(inspectUserTags(value, marker).ownerMatch).toBe(true);
    expect(inspectUserTags(value, marker).tagShape).toBe(Array.isArray(value) ? 'array' : 'string');
  });

  it.each([null, {}, 3, [], ['monitoring'], ['monitoring', marker, 'foreign'],
    `monitoring,${marker},foreign`, ['monitoring', marker, marker], ['monitoring', 3], 'monitoring,,owned_crash_run'])
  ('refuses malformed, missing, extra and foreign tag values', value => {
    expect(inspectUserTags(value, marker).ownerMatch).toBe(false);
  });

  it('refuses downstream setup and foreign deletion on an unexpected owner marker', async () => {
    let deleted = false;
    let inspectedCleanup = false;
    let granted = false;
    const ops: OwnedOps = { absent: async () => true, createVhost: async () => undefined,
      createUser: async () => undefined, inspectUser: async () => inspectUserTags(['monitoring', 'foreign'], marker),
      grant: async () => { granted = true; }, removeVhost: async () => 'removed',
      removeUser: () => removeOwnedUser(marker, async () => { inspectedCleanup = true; return ['monitoring', 'foreign']; },
        async () => { deleted = true; }, async () => true), removeDb: async () => 'absent' };
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await expect(scope.setup()).rejects.toBeInstanceOf(OwnerMismatchError);
    expect(scope.userOwnership).toEqual({ tagShape: 'array', ownerMatch: false });
    expect(granted).toBe(false);
    expect((await scope.cleanup()).user.status).toBe('owner_mismatch');
    expect(inspectedCleanup).toBe(true);
    expect(deleted).toBe(false);
  });

  it('uses the same marker to inspect and remove after a later setup failure', async () => {
    let deleted = false;
    const ops: OwnedOps = { absent: async () => true, createVhost: async () => undefined,
      createUser: async () => undefined, inspectUser: async () => inspectUserTags(`monitoring,${marker}`, marker),
      grant: async () => { throw new Error('later setup failure'); }, removeVhost: async () => 'removed',
      removeUser: () => removeOwnedUser(marker, async () => ['monitoring', marker],
        async () => { deleted = true; }, async () => true), removeDb: async () => 'absent' };
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await expect(scope.setup()).rejects.toThrow('later setup failure');
    expect(scope.userOwnership).toEqual({ tagShape: 'string', ownerMatch: true });
    expect((await scope.cleanup()).user.status).toBe('removed');
    expect(deleted).toBe(true);
  });

  it.each([`monitoring,${marker}`, ['monitoring', marker]])
  ('checks each GET shape before deleting only the proven-owned user', async tags => {
    let deletes = 0;
    expect(await removeOwnedUser(marker, async () => tags, async () => { deletes++; }, async () => true))
      .toBe('removed');
    expect(deletes).toBe(1);
  });

  it('never deletes an unowned or malformed user and distinguishes an absent user', async () => {
    let deletes = 0;
    const remove = async () => { deletes++; };
    await expect(removeOwnedUser(marker, async () => ['monitoring', marker, 'foreign'], remove,
      async () => true)).rejects.toBeInstanceOf(OwnerMismatchError);
    await expect(removeOwnedUser(marker, async () => undefined, remove,
      async () => true)).rejects.toBeInstanceOf(OwnerMismatchError);
    expect(await removeOwnedUser(marker, async () => null, remove, async () => true)).toBe('absent');
    expect(deletes).toBe(0);
  });
});
