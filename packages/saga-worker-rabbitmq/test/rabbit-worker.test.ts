import { describe, expect, it } from '@jest/globals';
import { SagaTurnTransientError, SagaTurnUnsupportedError, type SagaTurnRouteOutcome } from '@redemeine/saga-runtime';
import type { ConsumeMessage, Options, Replies } from 'amqplib';
import {
  createSagaRabbitWorker,
  type SagaRabbitChannel,
  type SagaRabbitQueueConfig,
  type SagaSourceEventProcessor
} from '../src/index';

interface Settlement {
  readonly message: ConsumeMessage;
  readonly allUpTo: boolean | undefined;
  readonly requeue?: boolean;
}

class FakeChannel implements SagaRabbitChannel {
  readonly acks: Settlement[] = [];
  readonly nacks: Settlement[] = [];
  readonly consumeCalls: Array<{ queue: string; options: Options.Consume | undefined }> = [];
  readonly cancelCalls: string[] = [];
  callback: ((message: ConsumeMessage | null) => void) | null = null;

  async consume(queue: string, callback: (message: ConsumeMessage | null) => void, options?: Options.Consume): Promise<Replies.Consume> {
    this.consumeCalls.push({ queue, options });
    this.callback = callback;
    return { consumerTag: 'consumer-1' };
  }

  async cancel(consumerTag: string): Promise<Replies.Empty> {
    this.cancelCalls.push(consumerTag);
    return {};
  }

  ack(message: ConsumeMessage, allUpTo?: boolean): void {
    this.acks.push({ message, allUpTo });
  }

  nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void {
    this.nacks.push({ message, allUpTo, requeue });
  }
}

const queue: SagaRabbitQueueConfig = {
  queue: 'saga-turns',
  deadLetterExchange: 'saga-turns.dlx',
  deadLetterConfigured: true
};

function body() {
  return {
    id: 'commit-1',
    partitionId: 'orders',
    streamId: 'order-1',
    commitSequence: 0,
    createDateTime: '2026-09-21T10:00:00.000Z',
    events: [
      { id: 'event-1', type: 'order.created.event', version: 0, payload: { orderId: 'order-1' }, metadata: { correlationId: 'corr-1' } },
      { id: 'event-2', type: 'order.paid.event', version: 1, payload: { orderId: 'order-1' }, metadata: { causationId: 'event-1' } }
    ]
  };
}

function message(overrides: { readonly body?: unknown; readonly contentType?: unknown; readonly messageId?: unknown; readonly headers?: unknown } = {}): ConsumeMessage {
  const value = overrides.body ?? body();
  return {
    content: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    fields: { consumerTag: 'consumer-1', deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'saga-turns' },
    properties: {
      contentType: overrides.contentType ?? 'application/json',
      contentEncoding: undefined,
      headers: overrides.headers ?? { partitionId: 'orders', streamId: 'order-1', collection: 'commits' },
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: overrides.messageId ?? 'commit-1',
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  };
}

function worker(channel: FakeChannel, processEvent: SagaSourceEventProcessor, queueConfig = queue) {
  return createSagaRabbitWorker({ channel, queue: queueConfig, processEvent });
}

const noRoutes: readonly SagaTurnRouteOutcome[] = [];

describe('Rabbit saga worker', () => {
  it('requires a declared DLX and consumes with manual acknowledgements', async () => {
    const channel = new FakeChannel();
    const invalid = worker(channel, async () => noRoutes, { ...queue, deadLetterConfigured: false });
    await expect(invalid.start()).rejects.toThrow('dead-letter exchange');
    expect(channel.consumeCalls).toHaveLength(0);

    const target = worker(channel, async () => noRoutes);
    await expect(target.start()).resolves.toBe('consumer-1');
    expect(channel.consumeCalls).toEqual([{ queue: 'saga-turns', options: { noAck: false } }]);
    channel.callback?.(null);
    await target.stop();
    expect(channel.cancelCalls).toEqual(['consumer-1']);
  });

  it('maps ordered commit events and ACKs no-match only after all processing', async () => {
    const channel = new FakeChannel();
    const seen: string[] = [];
    const target = worker(channel, async (source) => {
      seen.push(source.eventId);
      expect(channel.acks).toHaveLength(0);
      return noRoutes;
    });
    await target.handle(message());
    expect(seen).toEqual(['event-1', 'event-2']);
    expect(channel.acks).toEqual([{ message: expect.any(Object), allUpTo: false }]);
    expect(channel.nacks).toHaveLength(0);
  });

  it('does not ACK while processor work remains unresolved', async () => {
    const channel = new FakeChannel();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = worker(channel, async () => {
      await pending;
      return noRoutes;
    });
    const handling = target.handle(message({ body: { ...body(), events: [body().events[0]] } }));
    await Promise.resolve();
    expect(channel.acks).toHaveLength(0);
    release?.();
    await handling;
    expect(channel.acks).toHaveLength(1);
  });

  it.each([
    [new SagaTurnTransientError('temporary', 'temporary'), true],
    [new SagaTurnUnsupportedError('unsupported_intents', 'unsupported'), false]
  ] as const)('maps typed processor errors to exact NACK requeue behavior', async (error, requeue) => {
    const channel = new FakeChannel();
    const target = worker(channel, async () => {
      throw error;
    });
    await target.handle(message());
    expect(channel.nacks).toEqual([{ message: expect.any(Object), allUpTo: false, requeue }]);
    expect(channel.acks).toHaveLength(0);
  });

  it('defaults unknown processor failures to transient requeue', async () => {
    const channel = new FakeChannel();
    const target = worker(channel, async () => {
      throw new Error('unknown');
    });
    await target.handle(message());
    expect(channel.nacks[0]).toMatchObject({ allUpTo: false, requeue: true });
  });

  it.each([
    message({ body: '{bad-json' }),
    message({ contentType: 'text/plain' }),
    message({ messageId: 'wrong' }),
    message({ headers: { partitionId: 'wrong', streamId: 'order-1', collection: 'commits' } }),
    message({ headers: { partitionId: 'orders', streamId: 'order-1' } }),
    message({ body: { ...body(), events: [] } })
  ])('rejects malformed wire messages to the configured DLQ path', async (input) => {
    const channel = new FakeChannel();
    const target = worker(channel, async () => noRoutes);
    await target.handle(input);
    expect(channel.nacks).toEqual([{ message: input, allUpTo: false, requeue: false }]);
    expect(channel.acks).toHaveLength(0);
  });

  it('stops at the first failed event and settles a partial commit once', async () => {
    const channel = new FakeChannel();
    const seen: string[] = [];
    const target = worker(channel, async (source) => {
      seen.push(source.eventId);
      if (source.eventId === 'event-2') throw new SagaTurnTransientError('temporary', 'temporary');
      return [{ status: 'committed', sagaKey: 'orders', sourceTriggerId: 'trigger', instanceId: 'saga', routeId: 'route', commitId: 'turn' }];
    });
    await target.handle(message());
    expect(seen).toEqual(['event-1', 'event-2']);
    expect(channel.acks).toHaveLength(0);
    expect(channel.nacks).toHaveLength(1);
    expect(channel.nacks[0]?.requeue).toBe(true);
  });
});
