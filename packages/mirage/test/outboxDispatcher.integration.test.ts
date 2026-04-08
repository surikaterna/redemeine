import { describe, expect, test } from '@jest/globals';
import {
  InMemoryOutboxStore,
  OutboxDispatcherWorker,
  OutboxLeasedMessage,
  OutboxMessage,
  OutboxDispatchResult
} from '../src/outboxDispatcher';

describe('OutboxDispatcherWorker integration', () => {
  const now = 1000;

  const createWorker = (
    store: InMemoryOutboxStore,
    handler: (message: OutboxLeasedMessage) => Promise<OutboxDispatchResult>
  ) => {
    return new OutboxDispatcherWorker(
      store,
      { dispatch: handler },
      {
        workerId: 'worker-a',
        leaseMs: 250,
        batchSize: 2,
        retryPolicy: {
          baseDelayMs: 50,
          maxDelayMs: 500
        }
      }
    );
  };

  const seedMessage = (overrides: Partial<OutboxMessage> = {}): OutboxMessage => ({
    id: 'msg-1',
    deliveryKey: 'delivery-msg-1',
    payload: { value: 1 },
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    ...overrides,
    deliveryKey: overrides.deliveryKey ?? `delivery-${overrides.id ?? 'msg-1'}`
  });

  test('dispatches claimed messages successfully', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([seedMessage({ id: 'msg-1' })]);

    const worker = createWorker(store, async () => ({ kind: 'success' }));
    const result = await worker.runOnce(now);

    expect(result).toEqual({
      claimed: 1,
      recoveredLeases: 0,
      dispatched: 1,
      deduped: 0,
      retried: 0,
      deadLettered: 0
    });

    expect(store.snapshot('msg-1')).toMatchObject({
      status: 'dispatched',
      dispatchedAt: now,
      attempts: 0
    });
  });

  test('schedules retry on transient failure with deterministic backoff', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([seedMessage({ id: 'msg-retry' })]);

    const worker = createWorker(store, async () => ({
      kind: 'transient_error',
      error: 'temporary-network-fault'
    }));

    const result = await worker.runOnce(now);
    expect(result.retried).toBe(1);

    expect(store.snapshot('msg-retry')).toMatchObject({
      status: 'retry_scheduled',
      attempts: 1,
      availableAt: now + 50,
      lastError: 'temporary-network-fault'
    });
  });

  test('moves message to dead-letter on permanent failure', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([seedMessage({ id: 'msg-dlq' })]);

    const worker = createWorker(store, async () => ({
      kind: 'permanent_error',
      error: 'invalid-payload'
    }));

    const result = await worker.runOnce(now);
    expect(result.deadLettered).toBe(1);

    expect(store.snapshot('msg-dlq')).toMatchObject({
      status: 'dead_lettered',
      attempts: 1,
      lastError: 'invalid-payload',
      deadLetteredAt: now
    });
  });

  test('moves message to dead-letter when max attempts is exceeded', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([
      seedMessage({
        id: 'msg-max',
        attempts: 2,
        maxAttempts: 3
      })
    ]);

    const worker = createWorker(store, async () => ({
      kind: 'transient_error',
      error: 'still-failing'
    }));

    const result = await worker.runOnce(now);
    expect(result.deadLettered).toBe(1);

    expect(store.snapshot('msg-max')).toMatchObject({
      status: 'dead_lettered',
      attempts: 3,
      lastError: 'still-failing'
    });
  });

  test('recovers expired lease and allows re-claim in same run', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([
      seedMessage({
        id: 'msg-expired',
        status: 'leased',
        leaseOwner: 'worker-stale',
        leaseToken: 'stale-token',
        leaseExpiresAt: now - 1
      })
    ]);

    const dispatchedIds: string[] = [];
    const worker = createWorker(store, async (message) => {
      dispatchedIds.push(message.id);
      return { kind: 'success' };
    });

    const result = await worker.runOnce(now);
    expect(result.recoveredLeases).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(dispatchedIds).toEqual(['msg-expired']);
    expect(store.snapshot('msg-expired')?.status).toBe('dispatched');
  });

  test('marks duplicate delivery key as deduped without dispatching', async () => {
    const store = new InMemoryOutboxStore();
    const existing = seedMessage({ id: 'msg-original', deliveryKey: 'shared-key' });
    const duplicate = seedMessage({ id: 'msg-duplicate', deliveryKey: 'shared-key', availableAt: now + 1 });
    store.seed([existing, duplicate]);

    const worker = createWorker(store, async (message) => {
      if (message.id === 'msg-original') {
        return { kind: 'success' };
      }
      throw new Error('duplicate should not be dispatched');
    });

    const first = await worker.runOnce(now);
    expect(first.dispatched).toBe(1);
    expect(store.snapshot('msg-original')?.status).toBe('dispatched');

    const second = await worker.runOnce(now + 1);
    expect(second.deduped).toBe(1);
    expect(second.dispatched).toBe(0);
    expect(store.snapshot('msg-duplicate')).toMatchObject({
      status: 'dispatched',
      attempts: 0
    });
  });

  test('processes bounded batch size and leaves remaining due messages pending', async () => {
    const store = new InMemoryOutboxStore();
    store.seed([
      seedMessage({ id: 'msg-1' }),
      seedMessage({ id: 'msg-2' }),
      seedMessage({ id: 'msg-3' })
    ]);

    const processed: string[] = [];
    const worker = createWorker(store, async (message) => {
      processed.push(message.id);
      return { kind: 'success' };
    });

    const first = await worker.runOnce(now);
    expect(first.claimed).toBe(2);
    expect(processed).toEqual(['msg-1', 'msg-2']);
    expect(store.snapshot('msg-3')?.status).toBe('pending');

    const second = await worker.runOnce(now + 1);
    expect(second.claimed).toBe(1);
    expect(processed).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(store.snapshot('msg-3')?.status).toBe('dispatched');
  });
});
