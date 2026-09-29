import type { ChannelModel, ConfirmChannel, ConsumeMessage, Message } from 'amqplib';
import { SAGA_COMMIT_DEAD_QUEUE, SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE } from './commitQueueTopology';

/** One outstanding publish at a time: returns have no per-publish sequence number. */
export interface SagaConfirmedRepublisher {
  retry(message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>): Promise<void>;
  deadLetter(message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>): Promise<void>;
  close(): Promise<void>;
}

export class SagaPublishUncertainError extends Error {
  constructor(reason: string) {
    super(`saga republish uncertain: ${reason}; original delivery must remain unacknowledged`);
    this.name = 'SagaPublishUncertainError';
  }
}

/** Caller owns the model; this helper owns only its dedicated confirm channel. */
export async function createSagaConfirmedRepublisher(model: Pick<ChannelModel, 'createConfirmChannel'>,
  timeoutMs: number): Promise<SagaConfirmedRepublisher> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('confirm timeout must be positive');
  const channel = await model.createConfirmChannel();
  return new Republisher(channel, timeoutMs);
}

class Republisher implements SagaConfirmedRepublisher {
  private busy = false;
  private closed = false;
  constructor(private readonly channel: ConfirmChannel, private readonly timeoutMs: number) {
    channel.on('close', () => { this.closed = true; });
    channel.on('error', () => { this.closed = true; });
  }

  retry(message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>): Promise<void> {
    return this.send(SAGA_COMMIT_RETRY_EXCHANGE, SAGA_COMMIT_RETRY_QUEUE, message, headers);
  }

  deadLetter(message: ConsumeMessage, headers?: Readonly<Record<string, unknown>>): Promise<void> {
    return this.send('', SAGA_COMMIT_DEAD_QUEUE, message, headers);
  }

  private async send(exchange: string, key: string, message: ConsumeMessage,
    headers?: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.closed) throw new SagaPublishUncertainError('channel closed');
    if (this.busy) throw new SagaPublishUncertainError('in-flight limit reached');
    if (!message.properties.messageId) throw new TypeError('source messageId required');
    this.busy = true;
    try {
      await this.publish(exchange, key, message, headers);
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private publish(exchange: string, key: string, message: ConsumeMessage,
    headers?: Readonly<Record<string, unknown>>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let returned = false;
      let confirmed = false;
      let drained = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.channel.off('return', onReturn);
        this.channel.off('close', onClose);
        this.channel.off('error', onClose);
        this.channel.off('drain', onDrain);
        if (error) reject(error);
        else resolve();
      };
      const onReturn = (delivery: Message) => {
        if (delivery.properties.messageId !== message.properties.messageId) {
          finish(new SagaPublishUncertainError('unmatched mandatory return'));
          return;
        }
        returned = true;
      };
      const onClose = () => finish(new SagaPublishUncertainError('channel lost before confirmation'));
      const onDrain = () => { drained = true; if (confirmed) finish(); };
      const timer = setTimeout(() => finish(new SagaPublishUncertainError('confirmation or drain timed out')), this.timeoutMs);
      this.channel.on('return', onReturn);
      this.channel.on('close', onClose);
      this.channel.on('error', onClose);
      this.channel.on('drain', onDrain);
      try {
        const properties = { ...message.properties, headers: { ...message.properties.headers, ...headers },
          deliveryMode: 2, mandatory: true };
        drained = this.channel.publish(exchange, key, message.content, properties, (error) => {
          if (error) return finish(new SagaPublishUncertainError('broker rejected publish'));
          if (returned) return finish(new SagaPublishUncertainError('mandatory publish was returned'));
          confirmed = true;
          if (drained) finish();
        });
        if (confirmed && drained) finish();
      } catch {
        finish(new SagaPublishUncertainError('publish failed'));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A broken channel may never answer close; the pending send has its own deadline.
      await Promise.race([
        this.channel.close().catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
