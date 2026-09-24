import type { ConsumeMessage, Options } from 'amqplib';

export interface RetryConfirmChannel {
  sendToQueue(queue: string, content: Buffer, options: Options.Publish): boolean;
  waitForConfirms(): Promise<void>;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'return', listener: (message: ConsumeMessage) => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
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

function waitForDrain(channel: RetryConfirmChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      channel.off('drain', onDrain);
      channel.off('close', onClose);
      channel.off('error', onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => {
      finish();
    };
    const onClose = (): void => {
      finish(new Error('Rabbit channel closed before retry publisher drain.'));
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    try {
      channel.on('drain', onDrain);
      if (!settled) channel.on('close', onClose);
      if (!settled) channel.on('error', onError);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    if (settled) cleanup();
  });
}

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
    if (!accepted) await waitForDrain(channel);
    await channel.waitForConfirms();
    await nextTurn();
    if (returnedCount > 0) throw new Error(`Retry publication was returned by Rabbit: ${queue}`);
    return { attemptedAt, confirmedAt: new Date(), confirmCount: 1, returnedCount, backpressureWaitCount };
  } finally {
    channel.off('return', onReturn);
  }
}
