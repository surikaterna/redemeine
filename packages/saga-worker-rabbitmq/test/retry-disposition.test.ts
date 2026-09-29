import { describe, expect, it } from '@jest/globals';
import { SagaTurnPermanentError, SagaTurnTransientError } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';
import type { SagaConfirmedRepublisher } from '../src/confirmedRepublisher';
import { createSagaRabbitWorker } from '../src/SagaRabbitWorker';
import { SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE } from '../src/commitQueueTopology';
import { retryAttempt } from '../src/retryDisposition';
import { bindSagaRegistrations } from '@redemeine/saga-runtime';
import { createSagaSourceEventProcessor } from '../src/contracts';
import { createCounters, createTurnTable, FakeTurnRepository } from '../../saga-runtime/test/fixtures/turn-processor.fixture';
import { body, deferred, FakeChannel, flush, message, options } from './helpers';

const input = (headers: Record<string, unknown> = {}): ConsumeMessage => message({
  body: { ...body(), events: [body().events[0]] },
  headers: { partitionId: 'orders', streamId: 'order-1', collection: 'commits', ...headers }
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('fake broker delivery did not settle');
}

function registeredInput(payload: Record<string, unknown>, headers: Record<string, unknown> = {}): ConsumeMessage {
  return message({ messageId: 'source-commit-1', body: { ...body(), id: 'source-commit-1', partitionId: 'partition-1',
    streamId: 'orders-order-1', events: [{ id: 'source-event-1', type: 'turn.order-placed.v1.event',
      version: 4, payload, aggregateType: 'turn-orders', aggregateId: 'order-1',
      metadata: { tenant: 'tenant-1', correlationId: 'correlation-1', causationId: 'causation-1' } }] },
  headers: { partitionId: 'partition-1', streamId: 'orders-order-1', collection: 'commits', ...headers } });
}

function fixture(maxAttempts: number, processEvent: NonNullable<ReturnType<typeof options>['processEvent']>, ready = false,
  scope = options(new FakeChannel(), processEvent).source) {
  let closeCount = 0;
  let closeFailure: unknown;
  const channel = new class extends FakeChannel {
    close(): Promise<void> { closeCount += 1; if (closeFailure) throw closeFailure; return Promise.resolve(); }
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
    source: scope,
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
  return { channel, worker, sent, pending, get closeCount() { return closeCount; },
    failClose(error: unknown) { closeFailure = error; } };
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
    { 'rdm-saga-retry-attempt': 1, 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE, reason: 'expired', count: 2 }] },
    { 'rdm-saga-retry-attempt': 1 },
    { 'rdm-saga-retry-attempt': 2, 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE, reason: 'expired', count: 1 }] }
  ])('rejects malformed/spoofed attempt and TTL evidence', (headers) => {
    expect(() => retryAttempt(input(headers), 2)).toThrow('retry');
  });

  it('accepts Rabbit TTL x-death with extra broker fields but never redelivered as provenance', () => {
    const returned = input({ 'rdm-saga-retry-attempt': 1, 'x-death': [{ count: 1,
      reason: 'expired', queue: SAGA_COMMIT_RETRY_QUEUE, exchange: SAGA_COMMIT_RETRY_EXCHANGE,
      'routing-keys': [SAGA_COMMIT_RETRY_QUEUE], time: new Date('2026-09-29T00:00:00Z') }] });
    expect(retryAttempt(returned, 2)).toBe(1);
    const spoofed = { ...returned, properties: { ...returned.properties,
      headers: { ...returned.properties.headers, 'x-death': undefined } },
      fields: { ...returned.fields, redelivered: true } };
    expect(() => retryAttempt(spoofed, 2)).toThrow('retry attempt lacks broker TTL evidence');
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

  it('reports the original failed publish despite observer and close throwing', async () => {
    const f = fixture(1, async () => { throw new SagaTurnTransientError('temporary', 'secret'); });
    const original = new Error('confirm nack');
    f.failClose(new Error('synchronous channel close failure'));
    const observer: unknown[] = [];
    const retry = options(f.channel, async () => { throw new SagaTurnTransientError('temporary', 'secret'); }, [], {
      queue: { ...options(f.channel, async () => []).queue, queue: 'rdm.saga.commits' },
      retry: { maxAttempts: 1, consumerChannel: f.channel, publisher: {
        retry: async () => { throw original; }, deadLetter: async () => { throw original; }, close: async () => undefined
      }, topology: { queue: SAGA_COMMIT_RETRY_QUEUE, exchange: SAGA_COMMIT_RETRY_EXCHANGE,
        delayMs: 5000, inspect: async () => { throw new Error('not started'); } } },
      onSettlementError: async (failure) => { observer.push(failure); throw new Error('observer failed'); }
    });
    const target = createSagaRabbitWorker(retry);
    await expect(target.handle(input())).rejects.toBe(original);
    expect(observer).toEqual([expect.objectContaining({ settlement: 'publish', error: original })]);
    expect(f.channel.acks).toHaveLength(0);
    expect(f.channel.nacks).toHaveLength(0);
    expect(f.closeCount).toBe(1);
  });

  it('quarantines oversized headers only after confirmed DLQ publish', async () => {
    const f = fixture(2, async () => { throw new Error('should not run'); });
    const original = input({ extra: 'x'.repeat(8192) });
    const processing = f.worker.handle(original);
    await flush();
    expect(f.sent[0]?.kind).toBe('dlq');
    expect(f.channel.acks).toHaveLength(0);
    f.pending.resolve();
    await processing;
    expect(f.channel.acks).toHaveLength(1);
  });

  it.each([undefined, null, 'unknown'])('confirms a retry even when processor rejects %s', async (reason) => {
    const f = fixture(2, async () => { throw reason; });
    const processing = f.worker.handle(input());
    await flush();
    expect(f.sent[0]).toMatchObject({ kind: 'retry', headers: {
      'rdm-saga-retry-attempt': 1, 'rdm-saga-failure-reason': 'processor_unknown'
    } });
    expect(f.channel.acks).toHaveLength(0);
    f.pending.resolve();
    await processing;
    expect(f.channel.acks).toHaveLength(1);
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

  it('reconciles a confirmed-but-unACKed physical saga turn using the actual original-prefix processor', async () => {
    const repository = new FakeTurnRepository();
    const counters = createCounters();
    const table = createTurnTable('retry-original-prefix', counters);
    const processor = createSagaSourceEventProcessor(table, repository,
      { registrationForRoute: bindSagaRegistrations(table, table.registered) });
    let firstDelivery = true;
    const processEvent: typeof processor = async (source) => {
      const result = await processor(source);
      if (firstDelivery) {
        firstDelivery = false;
        throw new SagaTurnTransientError('after_commit', 'simulated failure after append');
      }
      return result;
    };
    const scope = { collection: 'commits', partitions: ['partition-1'] };
    const first = fixture(2, processEvent, true, scope);
    first.channel.ackError = new Error('ACK before broker receipt failed');
    await first.worker.start();
    first.channel.callbacks[0]?.(registeredInput({ orderId: 'order-1' }));
    await waitFor(() => first.sent.length === 1);
    expect(first.sent[0]).toMatchObject({ kind: 'retry', headers: { 'rdm-saga-failure-reason': 'after_commit' } });
    expect(first.channel.acks).toHaveLength(0);
    expect(repository.appendCalls).toHaveLength(1);
    expect(repository.appendCalls[0]?.events.map((event) => event.type)).toEqual([
      'saga.instance_created.event', 'saga.definition_identity_recorded.event',
      'saga.source_event_observed.event', 'saga.business_state_recorded.event'
    ]);
    first.pending.resolve();
    await waitFor(() => first.closeCount === 1);
    expect(first.channel.nacks).toHaveLength(0);

    const ttl = { 'rdm-saga-retry-attempt': 1, 'x-death': [{ queue: SAGA_COMMIT_RETRY_QUEUE,
      reason: 'expired', count: 1, exchange: SAGA_COMMIT_RETRY_EXCHANGE,
      'routing-keys': [SAGA_COMMIT_RETRY_QUEUE] }] };
    const replay = fixture(2, processEvent, true, scope);
    await replay.worker.start();
    replay.channel.callbacks[0]?.(registeredInput({ orderId: 'order-1' }, ttl));
    await waitFor(() => replay.channel.acks.length === 1);
    expect(repository.appendCalls).toHaveLength(1);
    expect(counters.start).toBe(2);
    expect(replay.sent).toHaveLength(0);
    const next = message({ messageId: 'source-commit-2',
      headers: { partitionId: 'partition-1', streamId: 'orders-order-1', collection: 'commits' },
      body: { ...body(), id: 'source-commit-2', partitionId: 'partition-1', streamId: 'orders-order-1',
        events: [{ id: 'event-2', type: 'turn.order-paid.v1.event', version: 5,
          aggregateType: 'turn-orders', aggregateId: 'order-1',
          payload: { orderId: 'order-1', mode: 'intent' }, metadata: { tenant: 'tenant-1' } }] } });
    replay.channel.callbacks[0]?.(next);
    await waitFor(() => replay.channel.acks.length === 2);
    expect(repository.appendCalls).toHaveLength(2);
    expect(repository.appendCalls[1]?.events.map((event) => event.type)).toEqual([
      'saga.source_event_observed.event', 'saga.business_state_recorded.event',
      'saga.intent_recorded.event', 'saga.timer_fact_recorded.event'
    ]);
    replay.channel.callbacks[0]?.(registeredInput({ orderId: 'order-1' }, ttl));
    await waitFor(() => replay.channel.acks.length === 3);
    expect(repository.appendCalls).toHaveLength(2);
    await replay.worker.stop();

    const divergent = fixture(2, processEvent, true, scope);
    await divergent.worker.start();
    divergent.channel.callbacks[0]?.(registeredInput({ orderId: 'order-1', amount: 99 }, ttl));
    await waitFor(() => divergent.sent.length === 1);
    expect(divergent.sent[0]?.kind).toBe('dlq');
    expect(divergent.channel.acks).toHaveLength(0);
    expect(repository.appendCalls).toHaveLength(2);
    divergent.pending.resolve();
    await waitFor(() => divergent.channel.acks.length === 1);
    expect(divergent.channel.nacks).toHaveLength(0);
    await divergent.worker.stop();
  });
});
