import { describe, expect, it } from '@jest/globals';
import { deadline, OwnedCrashScope, type OwnedOps } from '../integration/crashOwnership';

function fixture(fail: string): { ops: OwnedOps; calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (name === fail) throw new Error('injected failure');
  };
  return { calls, ops: {
    absent: async (kind) => { await step(`absent-${kind}`); return fail !== `collision-${kind}`; },
    createVhost: () => step('create-vhost'), createUser: () => step('create-user'),
    grant: () => step('grant'), removeVhost: () => step('remove-vhost'),
    removeUser: () => step('remove-user'), removeDb: () => step('remove-db')
  } };
}

describe('owned crash scope', () => {
  it('does not touch a preexisting name and never cleans an unarmed scope', async () => {
    const { calls, ops } = fixture('collision-user');
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await expect(scope.preflight()).rejects.toThrow('collision');
    expect(await scope.cleanup()).toEqual({ vhostDeleted: true, userDeleted: true, databaseDropped: true });
    expect(calls).toEqual(['absent-vhost', 'absent-user']);
  });

  it('deletes an attempted vhost even if later user creation fails', async () => {
    const { calls, ops } = fixture('create-user');
    const scope = new OwnedCrashScope({ vhost: 'v', user: 'u', db: 'd' }, ops);
    await scope.preflight();
    await expect(scope.setup()).rejects.toThrow('injected');
    expect(await scope.cleanup()).toEqual({ vhostDeleted: true, userDeleted: true, databaseDropped: true });
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
    expect(await scope.cleanup()).toEqual({ vhostDeleted: false, userDeleted: true, databaseDropped: true });
    expect(calls).toContain('remove-user');
    expect(calls).toContain('remove-db');
  });

  it('bounds a stalled cleanup and executes the enclosing receipt finally', async () => {
    const { ops, calls } = fixture('');
    ops.removeVhost = () => new Promise<void>(() => undefined);
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
    expect(outcome).toEqual({ vhostDeleted: false, userDeleted: true, databaseDropped: true });
    expect(calls).toContain('remove-user');
    expect(calls).toContain('remove-db');
  });
});
