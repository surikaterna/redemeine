import type { ConsumeMessage } from 'amqplib';
import type { SagaRabbitChannel } from '../src';
import { pollUntil, queueCounts } from './harness';

export interface DeliveryIdentity {
  readonly messageId: string | null;
  readonly sourceEventId: string | null;
}

export interface ObservedSettlement extends DeliveryIdentity {
  readonly kind: 'ack' | 'nack';
  readonly requeue?: boolean;
}

export interface SettlementTrace {
  readonly received: DeliveryIdentity[];
  readonly settled: ObservedSettlement[];
}

export interface ExpectedSettlement extends DeliveryIdentity {
  readonly kind: 'ack' | 'nack';
  readonly requeue?: boolean;
}

interface WaitDependencies {
  readonly poll: typeof pollUntil;
  readonly counts: typeof queueCounts;
}

function sourceEventId(message: Pick<ConsumeMessage, 'content'>): string | null {
  try {
    const value: unknown = JSON.parse(message.content.toString('utf8'));
    if (typeof value !== 'object' || value === null || !('events' in value) || !Array.isArray(value.events)) return null;
    const event: unknown = value.events[0];
    return typeof event === 'object' && event !== null && 'id' in event && typeof event.id === 'string' ? event.id : null;
  } catch {
    return null;
  }
}

export function deliveryIdentity(message: Pick<ConsumeMessage, 'content' | 'properties'>): DeliveryIdentity {
  return { messageId: message.properties.messageId ?? null, sourceEventId: sourceEventId(message) };
}

export function observeIdentitySettlements(base: SagaRabbitChannel, trace: SettlementTrace): SagaRabbitChannel {
  return {
    ack: (message, allUpTo) => {
      base.ack(message, allUpTo);
      trace.settled.push({ ...deliveryIdentity(message), kind: 'ack' });
    },
    nack: (message, allUpTo, requeue) => {
      base.nack(message, allUpTo, requeue);
      trace.settled.push({ ...deliveryIdentity(message), kind: 'nack', requeue: requeue ?? true });
    },
    consume: (queue, callback, options) => base.consume(queue, (message) => {
      if (message) trace.received.push(deliveryIdentity(message));
      callback(message);
    }, options),
    assertExchange: base.assertExchange.bind(base),
    assertQueue: base.assertQueue.bind(base),
    cancel: base.cancel.bind(base),
    prefetch: base.prefetch.bind(base)
  };
}

function matches(actual: ObservedSettlement, expected: ExpectedSettlement): boolean {
  return actual.kind === expected.kind && actual.messageId === expected.messageId &&
    actual.sourceEventId === expected.sourceEventId && actual.requeue === expected.requeue;
}

export async function waitForIdentitySettlement(
  trace: SettlementTrace, expected: ExpectedSettlement, ordinal: number, queue: string, deadQueue: string,
  timeoutMs = 15_000, dependencies: WaitDependencies = { poll: pollUntil, counts: queueCounts }
): Promise<void> {
  try {
    await dependencies.poll(`settlement ${ordinal} for ${expected.messageId}/${expected.sourceEventId}`, () =>
      trace.received.some((delivery) => delivery.messageId === expected.messageId && delivery.sourceEventId === expected.sourceEventId) &&
      trace.settled.length === ordinal && matches(trace.settled[ordinal - 1]!, expected), timeoutMs);
  } catch (error) {
    const [active, dead] = await Promise.allSettled([dependencies.counts(queue), dependencies.counts(deadQueue)]);
    throw new Error(`Expected settlement not observed: ${JSON.stringify({ expected, ordinal, received: trace.received,
      settled: trace.settled, queue: active, deadQueue: dead })}`, { cause: error });
  }
}
