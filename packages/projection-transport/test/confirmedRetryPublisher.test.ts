import type { ConsumeMessage } from 'amqplib';
import { publishConfirmedRetry, type RetryConfirmChannel } from '../integration/confirmedRetryPublisher';

function fakeChannel(order: string[], accepted: boolean): RetryConfirmChannel & { emitDrain(): void } {
  let drain = (): void => undefined;
  return {
    sendToQueue: (_queue, _content, options) => {
      order.push(`publish:${String(options.persistent)}:${String(options.mandatory)}`);
      return accepted;
    },
    waitForConfirms: async () => {
      order.push('confirmed');
    },
    once: (_event, listener) => {
      drain = listener;
    },
    on: () => undefined,
    off: () => undefined,
    emitDrain: () => {
      order.push('drain');
      drain();
    }
  };
}

describe('publishConfirmedRetry', () => {
  it('waits for backpressure drain and broker confirmation with durable mandatory flags', async () => {
    const order: string[] = [];
    const channel = fakeChannel(order, false);
    const pending = publishConfirmedRetry(channel, 'retry', Buffer.from('event'), { messageId: 'commit-1' });
    await Promise.resolve();
    expect(order).toEqual(['publish:true:true']);
    channel.emitDrain();
    const result = await pending;
    expect(order).toEqual(['publish:true:true', 'drain', 'confirmed']);
    expect(result).toMatchObject({ confirmCount: 1, returnedCount: 0, backpressureWaitCount: 1 });
  });

  it('rejects a mandatory publication returned before confirmation', async () => {
    let onReturn = (_message: ConsumeMessage): void => undefined;
    const channel = fakeChannel([], true);
    channel.on = (_event, listener) => {
      onReturn = listener;
    };
    channel.waitForConfirms = async () => {
      onReturn({ properties: { messageId: 'commit-1' } } as ConsumeMessage);
    };
    await expect(
      publishConfirmedRetry(channel, 'retry', Buffer.from('event'), {
        messageId: 'commit-1'
      })
    ).rejects.toThrow('returned by Rabbit');
  });
});
