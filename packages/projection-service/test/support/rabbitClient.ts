import { EventEmitter } from 'node:events';
import type { ConsumeMessage, Message } from 'amqplib';
import type { RabbitConnection, RabbitConnector } from '../../src/infrastructure/rabbit';
import { liveQueueName, type NativeRabbitChannel } from '../../src/infrastructure/rabbitChannel';

export class FakeRabbitChannel extends EventEmitter implements NativeRabbitChannel {
  handler: ((message: ConsumeMessage | null) => void) | undefined;
  checkQueue = jest.fn(async (queue: string) => ({ queue, messageCount: 0, consumerCount: 0 }));
  prefetch = jest.fn(async (_count: number, _global?: boolean) => ({}));
  consume = jest.fn(async (_queue: string, handler: (message: ConsumeMessage | null) => void, _options?: unknown) => {
    this.handler = handler; return { consumerTag: 'actual-consumer-tag' };
  });
  cancel = jest.fn(async (_tag: string) => ({}));
  ack = jest.fn((_message: Message, _allUpTo?: boolean) => {});
  close = jest.fn(async () => {});
}

export class FakeRabbitConnection extends EventEmitter implements RabbitConnection {
  readonly channel = new FakeRabbitChannel();
  createChannel = jest.fn(async () => this.channel);
  close = jest.fn(async () => {});
}

export function rabbitClientFixture() {
  const connection = new FakeRabbitConnection();
  const factory: RabbitConnector = jest.fn(async () => connection);
  return { connection, native: connection.channel, factory };
}

export function rawMessage(tag = 1): ConsumeMessage {
  return { content: Buffer.from('{"payload":"secret-canary"}'),
    fields: { deliveryTag: tag, redelivered: true, exchange: 'actual-exchange', routingKey: liveQueueName, consumerTag: 'actual-consumer-tag' },
    properties: { contentType: 'application/json', contentEncoding: undefined, headers: { collection: 'commits',
      partitionId: 'partition', tenant: 'tenant', streamId: 'actual-stream', token: Buffer.from('actual-token') },
      deliveryMode: 2, priority: undefined, correlationId: undefined, replyTo: undefined, expiration: undefined,
      messageId: 'actual-message-id', timestamp: undefined, type: undefined, userId: undefined, appId: undefined, clusterId: undefined } };
}
