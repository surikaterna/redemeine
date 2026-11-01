import { EventEmitter } from 'node:events';
import type { LiveRabbitChannel, LiveRabbitDelivery } from '@redemeine/projection-transport';
import type { OrderedFeedModel } from './feedModel';

export class ModelChannel extends EventEmitter implements LiveRabbitChannel {
  private handler: ((delivery: LiveRabbitDelivery | null) => void) | undefined;
  private prefetched = false;
  private closed = false;
  acknowledgements = 0;

  constructor(private readonly feed: OrderedFeedModel) { super(); }

  async checkQueue(queue: string): Promise<void> {
    if (this.closed || queue !== 'rdm.projection.commits') throw new Error('model:queue_refused');
  }

  async prefetch(count: number): Promise<void> {
    if (count !== 1) throw new Error('model:prefetch_refused');
    this.prefetched = true;
  }

  async consume(queue: string, handler: (delivery: LiveRabbitDelivery | null) => void,
    options: { noAck: false; exclusive: true }): Promise<{ consumerTag: string }> {
    await this.checkQueue(queue);
    if (!this.prefetched || this.handler || options.noAck !== false || options.exclusive !== true) {
      throw new Error('model:consumer_refused');
    }
    this.handler = handler;
    return { consumerTag: 'model:exclusive-consumer' };
  }

  deliver(redelivered = false): void {
    if (!this.handler || this.closed) throw new Error('model:no_consumer');
    this.handler(this.feed.issue(redelivered));
  }

  ack(delivery: LiveRabbitDelivery): void {
    if (this.closed) throw new Error('model:channel_closed');
    this.feed.acknowledge(delivery);
    this.acknowledgements += 1;
  }

  async cancel(): Promise<void> { this.handler = undefined; }

  async close(): Promise<void> {
    this.closed = true;
    this.handler = undefined;
    this.feed.loseContinuity();
    this.emit('close');
  }
}
