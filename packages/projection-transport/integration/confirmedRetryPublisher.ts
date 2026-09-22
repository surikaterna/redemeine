import type { ConsumeMessage, Options } from 'amqplib';

export interface RetryConfirmChannel {
  sendToQueue(queue: string, content: Buffer, options: Options.Publish): boolean;
  waitForConfirms(): Promise<void>;
  once(event: 'drain', listener: () => void): unknown;
  on(event: 'return', listener: (message: ConsumeMessage) => void): unknown;
  off(event: 'return', listener: (message: ConsumeMessage) => void): unknown;
}

export interface ConfirmedRetryPublication {
  readonly attemptedAt: Date;
  readonly confirmedAt: Date;
  readonly confirmCount: 1;
  readonly returnedCount: number;
  readonly backpressureWaitCount: number;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function publishConfirmedRetry(
  channel: RetryConfirmChannel,
  queue: string,
  content: Buffer,
  options: Options.Publish
): Promise<ConfirmedRetryPublication> {
  let returnedCount = 0;
  const onReturn = (message: ConsumeMessage): void => {
    if (message.properties.messageId === options.messageId) returnedCount += 1;
  };
  channel.on('return', onReturn);
  try {
    const attemptedAt = new Date();
    const accepted = channel.sendToQueue(queue, content, { ...options, persistent: true, mandatory: true });
    const backpressureWaitCount = accepted ? 0 : 1;
    if (!accepted) {
      await new Promise<void>((resolve) => {
        channel.once('drain', resolve);
      });
    }
    await channel.waitForConfirms();
    await nextTurn();
    if (returnedCount > 0) throw new Error(`Retry publication was returned by Rabbit: ${queue}`);
    return { attemptedAt, confirmedAt: new Date(), confirmCount: 1, returnedCount, backpressureWaitCount };
  } finally {
    channel.off('return', onReturn);
  }
}
