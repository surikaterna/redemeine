import { describe, expect, it } from '@jest/globals';
import { createSagaRabbitWorker, SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE } from '../src/index';
import { observedConsumerChannel } from '../integration/crashObservedChannel';
import { FakeChannel, flush, message, options } from './helpers';
import type { CrashSignal } from '../integration/crashIpc';

class Base extends FakeChannel {
  closes = 0;
  closeError: Error | null = null;
  async bindQueue(): Promise<{}> { this.calls.push('bind'); return {}; }
  async close(): Promise<void> { this.closes++; if (this.closeError) throw this.closeError; }
}

function fixture() {
  const base = new Base();
  const signals: CrashSignal[] = [];
  const channel = observedConsumerChannel(base, signal => signals.push(signal));
  const processEvent = async () => [];
  const original = options(base, processEvent);
  const config = options(base, processEvent, [], {
    channel, queue: { ...original.queue, queue: 'rdm.saga.commits' }, retry: {
      maxAttempts: 1, consumerChannel: channel,
      publisher: { retry: async () => undefined, deadLetter: async () => undefined, close: async () => undefined },
      topology: { queue: SAGA_COMMIT_RETRY_QUEUE, exchange: SAGA_COMMIT_RETRY_EXCHANGE, delayMs: 5000,
        inspect: async () => ({ streamQueueEnabled: true,
          queue: { name: SAGA_COMMIT_RETRY_QUEUE, type: 'quorum', durable: true, auto_delete: false, exclusive: false,
            arguments: { 'x-queue-type': 'quorum', 'x-message-ttl': 5000, 'x-dead-letter-exchange': '',
              'x-dead-letter-routing-key': 'rdm.saga.commits', 'x-dead-letter-strategy': 'at-least-once',
              'x-overflow': 'reject-publish' } },
          exchange: { name: SAGA_COMMIT_RETRY_EXCHANGE, type: 'direct', durable: true, auto_delete: false, arguments: {} },
          bindings: [{ source: SAGA_COMMIT_RETRY_EXCHANGE, destination: SAGA_COMMIT_RETRY_QUEUE,
            destination_type: 'queue', routing_key: SAGA_COMMIT_RETRY_QUEUE, arguments: {} }] }) }
    }
  });
  const worker = createSagaRabbitWorker(config);
  return { base, channel, signals, worker, config };
}

describe('one observable consumer channel', () => {
  it('passes strict worker identity at start and delegates settlement only after the real ACK', async () => {
    const { base, channel, signals, worker, config } = fixture();
    expect(channel).not.toBe(base);
    expect(config.channel).toBe(config.retry?.consumerChannel);
    await expect(worker.start()).resolves.toBe('consumer-1');
    expect(base.consumeCalls).toHaveLength(1);
    const delivery = message();
    channel.ack(delivery, false);
    expect(base.acks).toEqual([{ message: delivery, allUpTo: false }]);
    expect(signals).toContainEqual({ kind: 'ack', messageId: 'commit-1' });
    await channel.bindQueue('a', 'b', 'c');
    expect(base.calls).toContain('bind');
    await worker.stop();
    expect(base.closes).toBe(1);
  });

  it('broker cancellation closes the delegated channel without ACK/NACK or fabricated delivery', async () => {
    const { base, signals, worker } = fixture();
    await worker.start();
    base.callbacks[0]?.(null);
    await flush();
    expect(base.closes).toBe(1);
    expect(base.acks).toHaveLength(0);
    expect(base.nacks).toHaveLength(0);
    expect(signals).toEqual([]);
  });

  it('propagates actual ACK and close errors rather than reporting a successful settlement', async () => {
    const { base, channel, signals } = fixture();
    base.ackError = new Error('private ACK failure');
    expect(() => channel.ack(message())).toThrow('private ACK failure');
    expect(signals).toEqual([]);
    base.closeError = new Error('private close failure');
    await expect(channel.close()).rejects.toThrow('private close failure');
    expect(base.closes).toBe(1);
  });
});
