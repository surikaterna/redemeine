import { EventEmitter } from 'node:events';
import type { TransportChannel, TransportConfirmChannel, TransportConnection } from '../../integration/transportFaults';

export class OfflineChannel extends EventEmitter implements TransportConfirmChannel {
  published = 0;
  closeCalls = 0;
  neverClose = false;
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.neverClose) await new Promise<void>(() => {});
    this.emit('close');
  }
  async prefetch() { return {}; }
  async consume() { return { consumerTag: 'offline-consumer' }; }
  async cancel() { return {}; }
  nack(): void {}
  publish: TransportConfirmChannel['publish'] = () => { this.published += 1; return true; };
}

export class OfflineConnection extends EventEmitter implements TransportConnection {
  readonly channel = new OfflineChannel();
  closeCalls = 0;
  channelCalls = 0;
  neverClose = false;
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.neverClose) await new Promise<void>(() => {});
    this.emit('close');
  }
  async createChannel(): Promise<TransportChannel> { this.channelCalls += 1; return this.channel; }
  async createConfirmChannel(): Promise<TransportConfirmChannel> { this.channelCalls += 1; return this.channel; }
}
