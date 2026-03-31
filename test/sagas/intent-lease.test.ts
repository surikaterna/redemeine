import { describe, expect, it } from '@jest/globals';
import { InMemorySagaIntentLeaseStore } from '../../src/sagas';

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
});
