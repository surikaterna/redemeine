import { EventEmitter } from 'node:events';
import type { ConsumeMessage, Options } from 'amqplib';
import { publishConfirmedRetry, type RetryConfirmChannel } from '../integration/confirmedRetryPublisher';

class FakeConfirmChannel extends EventEmitter implements RetryConfirmChannel {
  confirmCount = 0;
  publishOptions?: Options.Publish;

  constructor(private readonly accepted: boolean) {
    super();
  }

  sendToQueue(_queue: string, _content: Buffer, options: Options.Publish): boolean {
    this.publishOptions = options;
    return this.accepted;
  }

  async waitForConfirms(): Promise<void> {
    this.confirmCount += 1;
  }
}

const publish = (channel: RetryConfirmChannel) => publishConfirmedRetry(channel, 'retry', Buffer.from('event'), { messageId: 'commit-1' });

function expectNoLifecycleListeners(channel: FakeConfirmChannel): void {
  expect(channel.listenerCount('drain')).toBe(0);
  expect(channel.listenerCount('close')).toBe(0);
  expect(channel.listenerCount('error')).toBe(0);
}

describe('publishConfirmedRetry', () => {
  it('waits for drain before broker confirmation and cleans lifecycle listeners', async () => {
    const channel = new FakeConfirmChannel(false);
    const pending = publish(channel);
    expect(channel.publishOptions).toMatchObject({ persistent: true, mandatory: true });
    expect(channel.listenerCount('drain')).toBe(1);
    expect(channel.listenerCount('close')).toBe(1);
    expect(channel.listenerCount('error')).toBe(1);
    channel.emit('drain');
    const result = await pending;
    expect(result).toMatchObject({ confirmCount: 1, returnedCount: 0, backpressureWaitCount: 1 });
    expect(channel.confirmCount).toBe(1);
    expectNoLifecycleListeners(channel);
    expect(channel.listenerCount('return')).toBe(0);
  });

  it('rejects when the channel closes before drain', async () => {
    const channel = new FakeConfirmChannel(false);
    const pending = publish(channel);
    channel.emit('close');
    await expect(pending).rejects.toThrow('closed before retry publisher drain');
    expect(channel.confirmCount).toBe(0);
    expectNoLifecycleListeners(channel);
  });

  it('rejects with the original channel error before drain', async () => {
    const channel = new FakeConfirmChannel(false);
    const failure = new Error('connection lost');
    const pending = publish(channel);
    channel.emit('error', failure);
    await expect(pending).rejects.toBe(failure);
    expect(channel.confirmCount).toBe(0);
    expectNoLifecycleListeners(channel);
  });

  it('settles once when drain wins a drain-close race', async () => {
    const channel = new FakeConfirmChannel(false);
    const pending = publish(channel);
    channel.emit('drain');
    channel.emit('close');
    await expect(pending).resolves.toMatchObject({ confirmCount: 1 });
    expect(channel.confirmCount).toBe(1);
    expectNoLifecycleListeners(channel);
  });

  it('settles once when close wins a close-drain race', async () => {
    const channel = new FakeConfirmChannel(false);
    const pending = publish(channel);
    channel.emit('close');
    channel.emit('drain');
    await expect(pending).rejects.toThrow('closed before retry publisher drain');
    expect(channel.confirmCount).toBe(0);
    expectNoLifecycleListeners(channel);
  });

  it('cleans listeners when close fires synchronously during registration', async () => {
    const channel = new FakeConfirmChannel(false);
    const originalOn = channel.on.bind(channel);
    channel.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'close') listener();
      return originalOn(event, listener);
    }) as typeof channel.on;
    await expect(publish(channel)).rejects.toThrow('closed before retry publisher drain');
    expectNoLifecycleListeners(channel);
  });

  it('rejects a mandatory publication returned before confirmation', async () => {
    const channel = new FakeConfirmChannel(true);
    channel.waitForConfirms = async () => {
      channel.emit('return', { properties: { messageId: 'commit-1' } } as ConsumeMessage);
    };
    await expect(publish(channel)).rejects.toThrow('returned by Rabbit');
    expect(channel.listenerCount('return')).toBe(0);
  });
});
