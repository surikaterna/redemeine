import type { ConsumeMessage, Options, Replies } from 'amqplib';
import type {
  SagaRabbitChannel,
  SagaRabbitQueueConfig,
  SagaRabbitSettlementError,
  SagaRabbitWorkerLimits,
  SagaRabbitWorkerOptions,
  SagaRabbitSourceScope,
  SagaSourceEventProcessor
} from '../src/index';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export interface Settlement {
  readonly message: ConsumeMessage;
  readonly allUpTo: boolean | undefined;
  readonly requeue?: boolean;
}

export class FakeChannel implements SagaRabbitChannel {
  readonly calls: string[] = [];
  readonly acks: Settlement[] = [];
  readonly nacks: Settlement[] = [];
  readonly consumeCalls: Array<{ queue: string; options: Options.Consume | undefined }> = [];
  readonly cancelCalls: string[] = [];
  readonly callbacks: Array<(message: ConsumeMessage | null) => void> = [];
  consumeResult: Promise<Replies.Consume> | null = null;
  cancelResult: Promise<Replies.Empty> | null = null;
  assertExchangeError: unknown;
  assertQueueError: unknown;
  ackError: unknown;
  nackError: unknown;

  async assertExchange(exchange: string, type: string, options?: Options.AssertExchange): Promise<Replies.AssertExchange> {
    this.calls.push(`exchange:${exchange}:${type}:${String(options?.durable)}`);
    if (this.assertExchangeError) throw this.assertExchangeError;
    return { exchange };
  }

  async assertQueue(queue: string, options?: Options.AssertQueue): Promise<Replies.AssertQueue> {
    this.calls.push(`queue:${queue}:${JSON.stringify(options)}`);
    if (this.assertQueueError) throw this.assertQueueError;
    return { queue, messageCount: 0, consumerCount: 0 };
  }

  async prefetch(count: number, global?: boolean): Promise<Replies.Empty> {
    this.calls.push(`prefetch:${count}:${String(global)}`);
    return {};
  }

  async consume(
    queue: string,
    callback: (message: ConsumeMessage | null) => void,
    options?: Options.Consume
  ): Promise<Replies.Consume> {
    this.calls.push(`consume:${queue}`);
    this.consumeCalls.push({ queue, options });
    this.callbacks.push(callback);
    return this.consumeResult ?? { consumerTag: `consumer-${this.consumeCalls.length}` };
  }

  async cancel(consumerTag: string): Promise<Replies.Empty> {
    this.calls.push(`cancel:${consumerTag}`);
    this.cancelCalls.push(consumerTag);
    return this.cancelResult ?? {};
  }

  ack(message: ConsumeMessage, allUpTo?: boolean): void {
    this.acks.push({ message, allUpTo });
    if (this.ackError) throw this.ackError;
  }

  nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void {
    this.nacks.push({ message, allUpTo, requeue });
    if (this.nackError) throw this.nackError;
  }
}

export const queue: SagaRabbitQueueConfig = {
  queue: 'saga-turns',
  options: {
    durable: true,
    autoDelete: false,
    exclusive: false,
    deadLetterExchange: 'saga-turns.dlx',
    deadLetterRoutingKey: 'saga-turns.dead'
  },
  deadLetterExchange: {
    name: 'saga-turns.dlx',
    type: 'direct',
    options: { durable: true, autoDelete: false }
  }
};

export const source: SagaRabbitSourceScope = { collection: 'commits', partitions: ['orders'] };
export const limits: SagaRabbitWorkerLimits = {
  maxBodyBytes: 16_384,
  maxEvents: 10,
  prefetch: 2,
  shutdownTimeoutMs: 1_000
};

export function body() {
  return {
    id: 'commit-1',
    partitionId: 'orders',
    streamId: 'order-1',
    commitSequence: 4,
    createDateTime: '2026-09-21T10:00:00.000Z',
    extraCommitField: 'allowed',
    events: [
      { id: 'event-1', type: 'order.created.event', version: 9, payload: { orderId: 'order-1' }, metadata: { correlationId: 'corr-1' } },
      { id: 'event-2', type: 'order.paid.event', version: 10, payload: { orderId: 'order-1' }, metadata: { causationId: 'event-1' }, extraEventField: true }
    ]
  };
}

interface MessageOverrides {
  readonly body?: unknown;
  readonly content?: Buffer;
  readonly contentType?: unknown;
  readonly messageId?: unknown;
  readonly headers?: unknown;
}

function override(overrides: MessageOverrides, key: keyof MessageOverrides, fallback: unknown): unknown {
  return Object.hasOwn(overrides, key) ? overrides[key] : fallback;
}

export function message(overrides: MessageOverrides = {}): ConsumeMessage {
  const value = override(overrides, 'body', body());
  const explicitContent = override(overrides, 'content', undefined);
  return {
    content: explicitContent instanceof Buffer ? explicitContent : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    fields: { consumerTag: 'consumer-1', deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'saga-turns' },
    properties: {
      contentType: override(overrides, 'contentType', 'application/json') as string,
      contentEncoding: undefined,
      headers: override(overrides, 'headers', { partitionId: 'orders', streamId: 'order-1', collection: 'commits' }) as Record<string, unknown>,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: override(overrides, 'messageId', 'commit-1') as string,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  };
}

export function options(
  channel: FakeChannel,
  processEvent: SagaSourceEventProcessor,
  failures: SagaRabbitSettlementError[] = [],
  overrides: Partial<SagaRabbitWorkerOptions> = {}
): SagaRabbitWorkerOptions {
  return {
    channel,
    queue,
    source,
    limits,
    processEvent,
    onSettlementError: (failure) => failures.push(failure),
    ...overrides
  };
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
