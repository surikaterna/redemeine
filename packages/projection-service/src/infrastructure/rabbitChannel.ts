import { EventEmitter } from 'node:events';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { LiveRabbitChannel, LiveRabbitDelivery } from '@redemeine/projection-transport';
import type { LiveDeliveryIdentity } from '@redemeine/projection-runtime-core';
import { InfrastructureError } from './failure';
import type { OwnedConsumerIdentity } from './brokerIdentity';
import { NativeRabbitClose } from './nativeRabbitClose';

export const liveQueueName = 'rdm.projection.commits';
export interface RabbitEvents {
  on(event: 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'error', listener: () => void): unknown;
}
export interface NativeRabbitChannel extends RabbitEvents, Pick<Channel, 'checkQueue' | 'prefetch' | 'consume' | 'cancel' | 'ack' | 'close'> {
  assertQueue?: Channel['assertQueue'];
  bindQueue?: Channel['bindQueue'];
}

export class RabbitChannelAdapter extends EventEmitter implements LiveRabbitChannel {
  private valid = true;
  private consuming = false;
  private prefetched = false;
  private checked = false;
  private lastTag = 0;
  private tag: string | undefined;
  private pending: LiveRabbitDelivery | undefined;
  private readonly originals = new WeakMap<LiveRabbitDelivery, ConsumeMessage>();
  private readonly nativeClosure: NativeRabbitClose;
  private readonly nativeClosed = () => { this.invalidate('close'); this.detachNative(); };
  private readonly nativeError = () => this.invalidate('error');

  constructor(private readonly native: NativeRabbitChannel, private readonly mode: 'exclusive' | 'single_active' = 'exclusive',
    private readonly ownedIdentity?: () => OwnedConsumerIdentity, private readonly expectedExchange?: string) {
    super();
    this.on('error', () => {});
    this.nativeClosure = new NativeRabbitClose(native);
    native.on('close', this.nativeClosed);
    native.on('error', this.nativeError);
  }

  identity(): OwnedConsumerIdentity {
    if (!this.ownedIdentity || this.mode !== 'single_active') throw new InfrastructureError('rabbit_prerequisite_failed');
    return this.ownedIdentity();
  }

  consumerTag(): string | undefined { return this.tag; }

  assertCurrent(): void {
    if (!this.valid || !this.consuming || !this.tag) throw new InfrastructureError('rabbit_prerequisite_failed');
  }

  owns(delivery: LiveDeliveryIdentity): boolean {
    return this.valid && this.consuming && this.pending !== undefined && this.originals.has(this.pending)
      && this.pending.fields.deliveryTag === delivery.deliveryTag && this.pending.fields.redelivered === delivery.redelivered
      && this.pending.properties.messageId === delivery.messageId;
  }

  invalidate(event: 'close' | 'error'): void {
    this.valid = false;
    this.consuming = false;
    this.pending = undefined;
    this.emit(event);
  }

  private assertUsableQueue(queue: string): void {
    if (!this.valid || queue !== liveQueueName) throw new InfrastructureError('rabbit_prerequisite_failed');
  }

  async checkQueue(queue: string): Promise<unknown> {
    this.assertUsableQueue(queue);
    try {
      const reply = await this.native.checkQueue(queue);
      this.assertUsableQueue(queue);
      if (reply.queue !== liveQueueName) throw new Error('queue_mismatch');
      this.checked = true;
      return reply;
    } catch { this.invalidate('error'); throw new InfrastructureError('rabbit_prerequisite_failed'); }
  }

  queueFacts() {
    return Object.freeze({ queue: liveQueueName, existence: this.checked ? 'observed' : 'unknown',
      expectedDurable: true, observedDurability: 'unknown', binding: 'unknown', effectiveNoDrop: 'unknown',
      qualification: 'unproven' });
  }

  async prefetch(count: number): Promise<void> {
    this.assertUsableQueue(liveQueueName);
    if (count !== 1) throw new InfrastructureError('rabbit_prerequisite_failed');
    try { await this.native.prefetch(1, false); this.prefetched = true; }
    catch { this.invalidate('error'); throw new InfrastructureError('rabbit_prerequisite_failed'); }
  }

  async consume(queue: string, handler: (delivery: LiveRabbitDelivery | null) => void,
    options: { noAck: false; exclusive: boolean }): Promise<{ consumerTag: string }> {
    this.assertUsableQueue(queue);
    if (!this.checked || !this.prefetched || this.consuming || options.noAck !== false || options.exclusive !== (this.mode === 'exclusive')) {
      throw new InfrastructureError('rabbit_prerequisite_failed');
    }
    this.consuming = true;
    try {
      const result = await this.native.consume(queue, (message) => this.receive(message, handler), { noAck: false, exclusive: options.exclusive });
      if (typeof result.consumerTag !== 'string' || !result.consumerTag || result.consumerTag.length > 512) throw new Error('invalid_consume_ok');
      this.tag = result.consumerTag;
      if (!this.valid || !this.consuming) { await this.cancel(this.tag); throw new Error('stale_consume_ok'); }
      return result;
    }
    catch { this.invalidate('error'); throw new InfrastructureError('rabbit_prerequisite_failed'); }
  }

  private receive(message: ConsumeMessage | null, handler: (delivery: LiveRabbitDelivery | null) => void): void {
    if (!this.valid || !this.consuming) return;
    if (!message) { this.invalidate('close'); handler(null); return; }
    if (!this.acceptablePublication(message)) { this.consuming = false; handler(null); return; }
    if (this.pending || !Number.isSafeInteger(message.fields.deliveryTag) || message.fields.deliveryTag <= this.lastTag
      || (message.properties.messageId !== undefined && typeof message.properties.messageId !== 'string')) {
      this.invalidate('error'); return;
    }
    this.lastTag = message.fields.deliveryTag;
    const delivery: LiveRabbitDelivery = Object.freeze({ content: Buffer.from(message.content),
      fields: Object.freeze({ deliveryTag: message.fields.deliveryTag, redelivered: message.fields.redelivered }),
      properties: Object.freeze({ ...(message.properties.messageId === undefined ? {} : { messageId: message.properties.messageId }),
        ...(message.properties.headers === undefined ? {} : { headers: Object.freeze({ ...message.properties.headers }) }) }) });
    this.originals.set(delivery, message);
    this.pending = delivery;
    handler(delivery);
  }

  private acceptablePublication(message: ConsumeMessage): boolean {
    if (this.mode !== 'single_active') return true;
    return message.fields.exchange === this.expectedExchange && message.fields.routingKey === ''
      && message.properties.deliveryMode === 2 && message.properties.expiration === undefined
      && message.properties.priority === undefined && message.properties.contentType === 'application/json';
  }

  ack(delivery: LiveRabbitDelivery): void {
    const original = this.originals.get(delivery);
    if (!this.valid || !this.consuming || this.pending !== delivery || !original) throw new InfrastructureError('rabbit_ack_refused');
    this.originals.delete(delivery);
    this.pending = undefined;
    try { this.native.ack(original, false); }
    catch { this.invalidate('error'); throw new InfrastructureError('rabbit_ack_refused'); }
  }

  async cancel(tag: string): Promise<void> {
    this.consuming = false;
    this.pending = undefined;
    if (this.nativeClosure.isClosed) return;
    try { await this.native.cancel(tag); }
    catch {
      if (this.nativeClosure.isClosed) return;
      this.invalidate('error'); throw new InfrastructureError('rabbit_prerequisite_failed');
    }
  }

  close(): Promise<void> {
    this.invalidate('close');
    return this.nativeClosure.close().then(() => this.detachNative());
  }

  private detachNative(): void {
    this.native.removeListener('close', this.nativeClosed);
    this.native.removeListener('error', this.nativeError);
  }
}
