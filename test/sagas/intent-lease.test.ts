import { describe, expect, it } from '@jest/globals';
import { InMemorySagaIntentLeaseStore } from '../../src/sagas/internal/runtime';

describe('S20 intent lease acquisition', () => {
  it('allows only one worker to acquire lease for same intent key at once', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const first = await leaseStore.acquireLease({
      intentKey: 'intent-123',
      workerId: 'worker-a',
      leaseDurationMs: 5_000,
      now: '2026-03-31T00:00:00.000Z'
    });

    const second = await leaseStore.acquireLease({
      intentKey: 'intent-123',
      workerId: 'worker-b',
      leaseDurationMs: 5_000,
      now: '2026-03-31T00:00:00.500Z'
    });

    expect(first).toBeDefined();
    expect(first?.workerId).toBe('worker-a');
    expect(second).toBeUndefined();
  });

  it('supports contention: only one concurrent acquisition succeeds', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const [workerA, workerB] = await Promise.all([
      leaseStore.acquireLease({
        intentKey: 'intent-contended',
        workerId: 'worker-a',
        leaseDurationMs: 10_000,
        now: '2026-03-31T00:00:00.000Z'
      }),
      leaseStore.acquireLease({
        intentKey: 'intent-contended',
        workerId: 'worker-b',
        leaseDurationMs: 10_000,
        now: '2026-03-31T00:00:00.000Z'
      })
    ]);

    const acquired = [workerA, workerB].filter(value => value !== undefined);
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.intentKey).toBe('intent-contended');

    const active = await leaseStore.getActiveLease('intent-contended', '2026-03-31T00:00:00.001Z');
    expect(active).toBeDefined();
    expect(active?.workerId).toBe(acquired[0]?.workerId);
  });

  it('allows a different worker after lease expiry', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const first = await leaseStore.acquireLease({
      intentKey: 'intent-expiry',
      workerId: 'worker-a',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.000Z'
    });

    const second = await leaseStore.acquireLease({
      intentKey: 'intent-expiry',
      workerId: 'worker-b',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.101Z'
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.workerId).toBe('worker-b');
    expect(second?.fencingToken).toBe(2);
  });

  it('renews lease expiry while execution is active', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const initial = await leaseStore.acquireLease({
      intentKey: 'intent-renew',
      workerId: 'worker-a',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.000Z'
    });

    if (!initial) {
      throw new Error('expected initial lease to be acquired');
    }

    expect(initial.expiresAt).toBe('2026-03-31T00:00:00.100Z');

    const renewed = await leaseStore.renewLease({
      intentKey: 'intent-renew',
      workerId: 'worker-a',
      leaseId: initial.leaseId,
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.050Z'
    });

    expect(renewed).toBeDefined();
    expect(renewed?.expiresAt).toBe('2026-03-31T00:00:00.150Z');

    const stillActiveAfterOriginalExpiry = await leaseStore.getActiveLease(
      'intent-renew',
      '2026-03-31T00:00:00.120Z'
    );
    expect(stillActiveAfterOriginalExpiry).toBeDefined();
    expect(stillActiveAfterOriginalExpiry?.workerId).toBe('worker-a');

    const expiredAfterRenewedWindow = await leaseStore.getActiveLease(
      'intent-renew',
      '2026-03-31T00:00:00.151Z'
    );
    expect(expiredAfterRenewedWindow).toBeUndefined();
  });

  it('supports heartbeat alias to renew lease expiry', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const initial = await leaseStore.acquireLease({
      intentKey: 'intent-heartbeat',
      workerId: 'worker-a',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.000Z'
    });

    if (!initial) {
      throw new Error('expected initial lease to be acquired');
    }

    const heartbeat = await leaseStore.heartbeatLease({
      intentKey: 'intent-heartbeat',
      workerId: 'worker-a',
      leaseId: initial.leaseId,
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.070Z'
    });

    expect(heartbeat).toBeDefined();
    expect(heartbeat?.expiresAt).toBe('2026-03-31T00:00:00.170Z');
  });

  it('releases completed lease and allows immediate reacquisition', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const initial = await leaseStore.acquireLease({
      intentKey: 'intent-release',
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      now: '2026-03-31T00:00:00.000Z'
    });

    if (!initial) {
      throw new Error('expected initial lease to be acquired');
    }

    const released = await leaseStore.releaseLease({
      intentKey: 'intent-release',
      workerId: 'worker-a',
      leaseId: initial.leaseId,
      now: '2026-03-31T00:00:00.050Z'
    });

    expect(released).toBe(true);

    const activeAfterRelease = await leaseStore.getActiveLease('intent-release', '2026-03-31T00:00:00.051Z');
    expect(activeAfterRelease).toBeUndefined();

    const reacquired = await leaseStore.acquireLease({
      intentKey: 'intent-release',
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
      now: '2026-03-31T00:00:00.052Z'
    });

    expect(reacquired).toBeDefined();
    expect(reacquired?.workerId).toBe('worker-b');
    expect(reacquired?.fencingToken).toBe(2);
  });

  it('fences stale worker release after expiry reclaim', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const initial = await leaseStore.acquireLease({
      intentKey: 'intent-stale-release',
      workerId: 'worker-a',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.000Z'
    });

    if (!initial) {
      throw new Error('expected initial lease to be acquired');
    }

    const reclaimed = await leaseStore.acquireLease({
      intentKey: 'intent-stale-release',
      workerId: 'worker-b',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.101Z'
    });

    if (!reclaimed) {
      throw new Error('expected reclaimed lease to be acquired');
    }

    const staleRelease = await leaseStore.releaseLease({
      intentKey: 'intent-stale-release',
      workerId: 'worker-a',
      leaseId: initial.leaseId,
      now: '2026-03-31T00:00:00.102Z'
    });

    expect(staleRelease).toBe(false);

    const stillHeldByReclaimer = await leaseStore.getActiveLease('intent-stale-release', '2026-03-31T00:00:00.103Z');
    expect(stillHeldByReclaimer).toBeDefined();
    expect(stillHeldByReclaimer?.workerId).toBe('worker-b');
    expect(stillHeldByReclaimer?.leaseId).toBe(reclaimed.leaseId);
    expect(stillHeldByReclaimer?.fencingToken).toBe(2);
  });

  it('rejects lease renewal from non-holder worker', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();

    const initial = await leaseStore.acquireLease({
      intentKey: 'intent-renew-fenced',
      workerId: 'worker-a',
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.000Z'
    });

    if (!initial) {
      throw new Error('expected initial lease to be acquired');
    }

    const renewalAttempt = await leaseStore.renewLease({
      intentKey: 'intent-renew-fenced',
      workerId: 'worker-b',
      leaseId: initial.leaseId,
      leaseDurationMs: 100,
      now: '2026-03-31T00:00:00.050Z'
    });

    expect(renewalAttempt).toBeUndefined();

    const expiresOnOriginalDeadline = await leaseStore.getActiveLease(
      'intent-renew-fenced',
      '2026-03-31T00:00:00.101Z'
    );
    expect(expiresOnOriginalDeadline).toBeUndefined();
  });

  it('S31 acceptance: concurrent workers contend and only lease holder executes intent', async () => {
    const leaseStore = new InMemorySagaIntentLeaseStore();
    const executionLog: string[] = [];
    let executionCount = 0;

    const attemptExecution = async (workerId: string) => {
      const lease = await leaseStore.acquireLease({
        intentKey: 'intent-s31-contention',
        workerId,
        leaseDurationMs: 30_000,
        now: '2026-03-31T00:00:00.000Z'
      });

      if (!lease) {
        return false;
      }

      executionCount += 1;
      executionLog.push(workerId);
      return true;
    };

    const workerIds = Array.from({ length: 16 }, (_unused, index) => `worker-${index + 1}`);
    const outcomes = await Promise.all(workerIds.map(workerId => attemptExecution(workerId)));

    const winners = workerIds.filter((_workerId, index) => outcomes[index]);
    expect(winners).toHaveLength(1);
    expect(executionCount).toBe(1);
    expect(executionLog).toEqual([winners[0]]);

    const activeLease = await leaseStore.getActiveLease('intent-s31-contention', '2026-03-31T00:00:00.001Z');
    expect(activeLease).toBeDefined();
    expect(activeLease?.workerId).toBe(winners[0]);
  });
});
