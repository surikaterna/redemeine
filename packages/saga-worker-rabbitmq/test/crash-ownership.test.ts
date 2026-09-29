import { describe, expect, it } from '@jest/globals';
import { deadline, OwnedCrashScope, OwnerMismatchError, type OwnedOps } from '../integration/crashOwnership';

function fixture(fail: string): { ops: OwnedOps; calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (name === fail) throw new Error('injected failure');
  };
  return { calls, ops: {
    absent: async (kind) => { await step(`absent-${kind}`); return fail !== `collision-${kind}`; },
    createVhost: () => step('create-vhost'), createUser: () => step('create-user'),
    grant: () => step('grant'), removeVhost: async () => { await step('remove-vhost'); return 'removed'; },
    removeUser: async () => { await step('remove-user'); return 'removed'; },
    removeDb: async () => { await step('remove-db'); return 'removed'; }
  } };
}

describe('owned crash scope', () => {
  it('does not touch a preexisting name and never cleans an unarmed scope', async () => {
    const { calls, ops } = fixture('collision-user');
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await expect(scope.preflight()).rejects.toThrow('collision');
    expect(await scope.cleanup()).toEqual({ vhost: { status: 'not_attempted', reason: 'none' },
      user: { status: 'not_attempted', reason: 'none' }, db: { status: 'not_attempted', reason: 'none' } });
    expect(calls).toEqual(['absent-vhost', 'absent-user']);
  });

  it('deletes an attempted vhost even if later user creation fails', async () => {
    const { calls, ops } = fixture('create-user');
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await expect(scope.setup()).rejects.toThrow('injected');
    expect(await scope.cleanup()).toEqual({ vhost: { status: 'removed', reason: 'none' },
      user: { status: 'removed', reason: 'none' }, db: { status: 'not_attempted', reason: 'none' } });
    expect(calls).toContain('remove-vhost');
    expect(calls).toContain('remove-user');
    expect(calls).not.toContain('remove-db');
  });

  it('attempts user and database cleanup even when vhost cleanup throws', async () => {
    const { calls, ops } = fixture('remove-vhost');
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await scope.setup();
    scope.markDbAttempted();
    expect(await scope.cleanup()).toEqual({ vhost: { status: 'failed', reason: 'failed' },
      user: { status: 'removed', reason: 'none' }, db: { status: 'removed', reason: 'none' } });
    expect(calls).toContain('remove-user');
    expect(calls).toContain('remove-db');
  });

  it('bounds a stalled cleanup and executes the enclosing receipt finally', async () => {
    const { ops, calls } = fixture('');
    ops.removeVhost = () => new Promise<'removed'>(() => undefined);
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops, 25);
    await scope.preflight();
    await scope.setup();
    scope.markDbAttempted();
    let receipt = false;
    let outcome: Awaited<ReturnType<typeof scope.cleanup>> | undefined;
    try {
      outcome = await deadline('teardown', () => scope.cleanup(), 1000);
    } finally { receipt = true; }
    expect(receipt).toBe(true);
    expect(outcome).toEqual({ vhost: { status: 'timeout', reason: 'timeout' },
      user: { status: 'removed', reason: 'none' }, db: { status: 'removed', reason: 'none' } });
    expect(calls).toContain('remove-user');
    expect(calls).toContain('remove-db');
  });

  it('refuses a foreign user marker but still attempts exact owned DB and vhost cleanup', async () => {
    const { calls, ops } = fixture('');
    ops.removeUser = async () => { calls.push('user-owner-mismatch'); throw new OwnerMismatchError(); };
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await scope.setup();
    scope.markDbAttempted();
    expect(await scope.cleanup()).toEqual({ vhost: { status: 'removed', reason: 'none' },
      user: { status: 'owner_mismatch', reason: 'owner_mismatch' }, db: { status: 'removed', reason: 'none' } });
    expect(calls).toContain('remove-db');
    expect(calls).not.toContain('remove-user');
  });

  it.each(['remove-db', 'stalled-db'])('keeps database %s uncertainty separate from user removal', async (mode) => {
    const { ops, calls } = fixture(mode);
    if (mode === 'stalled-db') ops.removeDb = () => new Promise<'removed'>(() => undefined);
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops, 20);
    await scope.preflight();
    await scope.setup();
    scope.markDbAttempted();
    const outcome = await scope.cleanup();
    expect(outcome.db.status).toBe(mode === 'stalled-db' ? 'timeout' : 'failed');
    expect(outcome.user.status).toBe('removed');
    expect(calls).toContain('remove-user');
  });
});
