import { describe, expect, it } from '@jest/globals';
import type { ConsumeMessage } from 'amqplib';
import type { SagaRabbitChannel } from '../src';
import { observeIdentitySettlements, type SettlementTrace, waitForIdentitySettlement } from './identitySettlements';

const expected = { kind: 'nack' as const, messageId: 'legacy-commit', sourceEventId: 'legacy-event', requeue: false };

function legacyMessage(): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ id: expected.messageId, events: [{ id: expected.sourceEventId }] })),
    fields: { consumerTag: 'consumer', deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'live' },
    properties: {
      contentType: 'application/json', contentEncoding: undefined, headers: {}, deliveryMode: undefined,
      priority: undefined, correlationId: undefined, replyTo: undefined, expiration: undefined,
      messageId: expected.messageId, timestamp: undefined, type: undefined, userId: undefined,
      appId: undefined, clusterId: undefined
    }
  };
}

function fakeChannel(callbacks: Array<(delivery: ConsumeMessage | null) => void>): SagaRabbitChannel {
  return {
    ack: () => undefined, nack: () => undefined,
    consume: async (_queue, callback) => { callbacks.push(callback); return { consumerTag: 'consumer' }; },
    assertExchange: async (exchange) => ({ exchange }),
    assertQueue: async (queue) => ({ queue: queue ?? 'live', messageCount: 0, consumerCount: 0 }),
    cancel: async () => ({}), prefetch: async () => ({})
  };
}

describe('identity-bound Rabbit settlement observation', () => {
  it('does not mistake stale DLQ counts or a received but unsettled legacy delivery for a third NACK', async () => {
    const callbacks: Array<(delivery: ConsumeMessage | null) => void> = [];
    const trace: SettlementTrace = {
      received: [{ messageId: 'first', sourceEventId: 'first-event' }, { messageId: 'duplicate', sourceEventId: 'duplicate-event' }],
      settled: [{ kind: 'ack', messageId: 'first', sourceEventId: 'first-event' },
        { kind: 'nack', messageId: 'duplicate', sourceEventId: 'duplicate-event', requeue: false }]
    };
    const observed = observeIdentitySettlements(fakeChannel(callbacks), trace);
    await observed.consume('live', () => undefined);
    const delivery = legacyMessage();
    callbacks[0]?.(delivery);
    let sampled = 0;
    await waitForIdentitySettlement(trace, expected, 3, 'live', 'dead', 100, {
      poll: async (_label, predicate) => {
        expect(await predicate()).toBe(false);
        observed.nack(delivery, false, false);
        expect(await predicate()).toBe(true);
      },
      counts: async () => { sampled += 1; return { ready: 1, unacknowledged: 0 }; }
    });
    expect(sampled).toBe(0);
    expect(trace.received[2]).toEqual({ messageId: 'legacy-commit', sourceEventId: 'legacy-event' });
    expect(trace.settled[2]).toEqual(expected);
  });

  it('reports per-message receipt, outcomes and both queues on a bounded timeout', async () => {
    const trace: SettlementTrace = {
      received: [{ messageId: 'legacy-commit', sourceEventId: 'legacy-event' }],
      settled: [{ kind: 'ack', messageId: 'first', sourceEventId: 'first-event' },
        { kind: 'nack', messageId: 'duplicate', sourceEventId: 'duplicate-event', requeue: false }]
    };
    const counts = async (queue: string) => queue === 'live'
      ? { ready: 0, unacknowledged: 1 } : { ready: 1, unacknowledged: 0 };
    const waiting = waitForIdentitySettlement(trace, expected, 3, 'live', 'dead', 100, {
      poll: async (_label, predicate) => {
        expect(await predicate()).toBe(false);
        throw new Error('timed out');
      }, counts
    });
    await expect(waiting).rejects.toThrow(/legacy-commit.*legacy-event.*received.*settled.*queue.*ready.*unacknowledged.*deadQueue/);
  });

  it('does not accept a third settlement for another message or a requeued NACK', async () => {
    const trace: SettlementTrace = {
      received: [{ messageId: expected.messageId, sourceEventId: expected.sourceEventId }],
      settled: [{ kind: 'ack', messageId: 'first', sourceEventId: 'first-event' },
        { kind: 'nack', messageId: 'duplicate', sourceEventId: 'duplicate-event', requeue: false },
        { kind: 'nack', messageId: expected.messageId, sourceEventId: expected.sourceEventId, requeue: true }]
    };
    await expect(waitForIdentitySettlement(trace, expected, 3, 'live', 'dead', 100, {
      poll: async (_label, predicate) => {
        expect(await predicate()).toBe(false);
        trace.settled[2] = { ...expected, messageId: 'different-commit' };
        expect(await predicate()).toBe(false);
        throw new Error('timed out');
      }, counts: async () => ({ ready: 0, unacknowledged: 0 })
    })).rejects.toThrow('Expected settlement not observed');
  });
});
