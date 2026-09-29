import { describe, expect, it } from '@jest/globals';
import { SagaTurnPermanentError, SagaTurnTransientError } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';
import type { SagaConfirmedRepublisher } from '../src/confirmedRepublisher';
import { createSagaRabbitWorker } from '../src/SagaRabbitWorker';
import { SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE } from '../src/commitQueueTopology';
import { retryAttempt } from '../src/retryDisposition';
import { body, deferred, FakeChannel, flush, message, options } from './helpers';

const input = (headers: Record<string, unknown> = {}): ConsumeMessage => message({
  body: { ...body(), events: [body().events[0]] },
  headers: { partitionId: 'orders', streamId: 'order-1', collection: 'commits', ...headers }
});

function fixture(maxAttempts: number, processEvent: NonNullable<ReturnType<typeof options>['processEvent']>, ready = false) {
  let closeCount = 0;
  const channel = new class extends FakeChannel {
    async close(): Promise<void> { closeCount += 1; }
  }();
  const sent: Array<{ kind: string; message: ConsumeMessage; headers: Readonly<Record<string, unknown>> | undefined }> = [];
  const pending = deferred<void>();
  const publisher: SagaConfirmedRepublisher = {
    retry: async (original, headers) => { sent.push({ kind: 'retry', message: original, headers }); await pending.promise; },
    deadLetter: async (original, headers) => { sent.push({ kind: 'dlq', message: original, headers }); await pending.promise; },
    close: async () => undefined
  };
  const worker = createSagaRabbitWorker(options(channel, processEvent, [], {
    queue: { ...options(channel, processEvent).queue, queue: 'rdm.saga.commits' },
    retry: {
      maxAttempts, publisher, consumerChannel: channel,
      topology: { queue: SAGA_COMMIT_RETRY_QUEUE, exchange: SAGA_COMMIT_RETRY_EXCHANGE,
        delayMs: 5000, inspect: async () => {
          if (!ready) throw new Error('not provisioned');
          return { streamQueueEnabled: true,
            queue: { name: SAGA_COMMIT_RETRY_QUEUE, type: 'quorum', durable: true, auto_delete: false, exclusive: false,
              arguments: { 'x-queue-type': 'quorum', 'x-message-ttl': 5000, 'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': 'rdm.saga.commits', 'x-dead-letter-strategy': 'at-least-once',
                'x-overflow': 'reject-publish' } },
            exchange: { name: SAGA_COMMIT_RETRY_EXCHANGE, type: 'direct', durable: true, auto_delete: false, arguments: {} },
            bindings: [{ source: SAGA_COMMIT_RETRY_EXCHANGE, destination: SAGA_COMMIT_RETRY_QUEUE,
              destination_type: 'queue', routing_key: SAGA_COMMIT_RETRY_QUEUE, arguments: {} }] };
        } }
    }
  }));
  return { channel, worker, sent, pending, get closeCount() { return closeCount; } };
}

describe('opt-in delayed settlement', () => {
  it('refuses intake before independent topology readiness and requires a fresh channel', async () => {
    const f = fixture(1, async () => []);
    await expect(f.worker.start()).rejects.toThrow('not provisioned');
    expect(f.channel.consumeCalls).toHaveLength(0);
    expect(f.closeCount).toBe(1);
    await expect(f.worker.start()).rejects.toThrow('fresh channel');
  });

  it.each([-1, 1.5, 101])('refuses invalid cap %s', async (cap) => {
    const f = fixture(cap, async () => []);
    await expect(f.worker.start()).rejects.toThrow('maxAttempts');
    expect(f.channel.consumeCalls).toHaveLength(0);
  });

  it('closes the consuming channel on broker cancellation without hot requeue', async () => {
    const f = fixture(1, async () => [], true);
    await f.worker.start();
    f.channel.callbacks[0]?.(null);
    await flush();
    expect(f.closeCount).toBe(1);
    expect(f.channel.nacks).toHaveLength(0);
    await expect(f.worker.start()).rejects.toThrow('fresh channel');
  });

  it('closes without settling deliveries that arrive after cancellation', async () => {
    const f = fixture(1, async () => [], true);
    await f.worker.start();
    const delivered = input();
    f.channel.callbacks[0]?.(null);
    f.channel.callbacks[0]?.(delivered);
    await flush();
    expect(f.channel.acks).toHaveLength(0);
    expect(f.channel.nacks).toHaveLength(0);
  });

  it.each([0, 1, 4])('enforces cap %i without ACK before confirmed publish', async (cap) => {
    const f = fixture(cap, async () => { throw new SagaTurnTransientError('temporary', 'secret detail'); });
    const original = input(cap === 0 ? {} : { 'rdm-saga-retry-attempt': cap - 1,
      ...(cap > 1 ? { 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE, reason: 'expired', count: cap - 1 }] } : {}) });
    const processing = f.worker.handle(original);
    await flush();
    expect(f.sent[0]?.kind).toBe(cap === 0 ? 'dlq' : 'retry');
    expect(f.sent[0]?.message).toBe(original);
    expect(f.channel.acks).toHaveLength(0);
    f.pending.resolve();
    await processing;
    expect(f.channel.acks).toHaveLength(1);
    expect(f.channel.nacks).toHaveLength(0);
    expect(f.sent[0]?.headers).toEqual({ 'rdm-saga-retry-attempt': cap === 0 ? 0 : cap,
      'rdm-saga-failure-reason': 'temporary' });
    expect(f.sent[0]?.headers).not.toHaveProperty('secret');
  });

  it('DLQs exhausted, permanent, and malformed identity without processing', async () => {
    let processed = 0;
    const f = fixture(1, async () => { processed += 1; throw new SagaTurnPermanentError('permanent', 'secret'); });
    const original = message({ body: { ...body(), id: 'spoofed' } });
    const processing = f.worker.handle(original);
    await flush();
    expect(processed).toBe(0);
    expect(f.sent[0]?.kind).toBe('dlq');
    f.pending.resolve();
    await processing;
    expect(f.channel.acks).toHaveLength(1);
  });

  it.each([
    { 'rdm-saga-retry-attempt': -1 },
    { 'rdm-saga-retry-attempt': 1.5 },
    { 'rdm-saga-retry-attempt': 2 },
    { 'rdm-saga-retry-attempt': 1, 'x-death': [{ queue: 'other', reason: 'expired', count: 1 }] },
    { 'rdm-saga-retry-attempt': 1, 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE, reason: 'rejected', count: 1 }] },
    { 'rdm-saga-retry-attempt': 1, 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE, reason: 'expired', count: 2 }] }
  ])('rejects malformed/spoofed attempt and TTL evidence', (headers) => {
    expect(() => retryAttempt(input(headers), 1)).toThrow('retry');
  });

  it('halts and leaves source unACKed on publisher failure', async () => {
    const f = fixture(1, async () => { throw new SagaTurnTransientError('temporary', 'temporary'); });
    const processing = f.worker.handle(input());
    await flush();
    f.pending.reject(new Error('confirm nack'));
    await expect(processing).rejects.toThrow('confirm nack');
    expect(f.closeCount).toBe(1);
    expect(f.channel.acks).toHaveLength(0);
    expect(f.channel.nacks).toHaveLength(0);
  });

  it('never ACKs an unclassified processor failure', async () => {
    const f = fixture(2, async () => { throw new Error('unknown'); });
    await expect(f.worker.handle(input())).rejects.toThrow('unclassified');
    expect(f.sent).toHaveLength(0);
    expect(f.channel.acks).toHaveLength(0);
    expect(f.closeCount).toBe(1);
  });

  it('leaves confirmed copy ambiguous on ACK throw, closes instead of NACKing', async () => {
    const f = fixture(1, async () => { throw new SagaTurnTransientError('temporary', 'temporary'); });
    f.channel.ackError = new Error('ACK failed');
    const processing = f.worker.handle(input());
    f.pending.resolve();
    await expect(processing).rejects.toThrow('ACK failed');
    expect(f.sent).toHaveLength(1);
    expect(f.channel.nacks).toHaveLength(0);
    expect(f.closeCount).toBe(1);
  });

  it('does not ACK after stop while confirmation is pending', async () => {
    const f = fixture(1, async () => { throw new SagaTurnTransientError('temporary', 'temporary'); });
    const processing = f.worker.handle(input());
    await flush();
    await f.worker.stop();
    f.pending.resolve();
    await processing;
    expect(f.channel.acks).toHaveLength(0);
    expect(f.channel.nacks).toHaveLength(0);
    expect(f.closeCount).toBe(1);
  });

  it('reprocesses redelivery with full source content instead of treating the same ID as success', async () => {
    let stored: string | undefined;
    const processEvent: NonNullable<ReturnType<typeof options>['processEvent']> = async (event) => {
      const material = JSON.stringify({ payload: event.payload, metadata: event.metadata, sequence: event.sequence });
      if (stored === undefined) stored = material;
      else if (stored !== material) throw new SagaTurnPermanentError('incompatible_turn_commit', 'changed');
      return [];
    };
    const first = fixture(1, processEvent);
    const original = input();
    await first.worker.handle(original);
    expect(first.channel.acks).toHaveLength(1);
    const duplicate = fixture(1, processEvent);
    await duplicate.worker.handle(input());
    expect(duplicate.channel.acks).toHaveLength(1);
    const changed = fixture(1, processEvent);
    const changedBody = { ...body(), events: [{ ...body().events[0], payload: { orderId: 'changed' } }] };
    const handling = changed.worker.handle(message({ body: changedBody }));
    await flush();
    expect(changed.sent[0]?.kind).toBe('dlq');
    expect(changed.channel.acks).toHaveLength(0);
    changed.pending.resolve();
    await handling;
    expect(changed.channel.acks).toHaveLength(1);
  });
});
