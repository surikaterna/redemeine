import { SagaTurnError } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';
import type { SagaRabbitWorker, SagaRabbitWorkerOptions } from './contracts';
import { decodeSagaRabbitMessage } from './decodeMessage';

function assertConfiguration(options: SagaRabbitWorkerOptions): void {
  if (options.queue.queue.length === 0) throw new TypeError('queue must not be empty');
  if (!options.queue.deadLetterConfigured || options.queue.deadLetterExchange.length === 0) {
    throw new TypeError('queue deployment must declare a configured dead-letter exchange');
  }
}

class RabbitSagaWorker implements SagaRabbitWorker {
  private readonly options: SagaRabbitWorkerOptions;
  private readonly inFlight = new Set<Promise<void>>();
  private consumerTag: string | null = null;

  constructor(options: SagaRabbitWorkerOptions) {
    this.options = options;
  }

  async start(): Promise<string> {
    assertConfiguration(this.options);
    if (this.consumerTag) return this.consumerTag;
    const reply = await this.options.channel.consume(
      this.options.queue.queue,
      (message) => this.track(message),
      { noAck: false }
    );
    this.consumerTag = reply.consumerTag;
    return reply.consumerTag;
  }

  async stop(): Promise<void> {
    const tag = this.consumerTag;
    this.consumerTag = null;
    if (tag) await this.options.channel.cancel(tag);
    await Promise.all(this.inFlight);
  }

  async handle(message: ConsumeMessage): Promise<void> {
    try {
      const events = decodeSagaRabbitMessage(message);
      for (const event of events) await this.options.processEvent(event);
      this.options.channel.ack(message, false);
    } catch (error) {
      const requeue = error instanceof SagaTurnError ? error.retryable : true;
      this.options.channel.nack(message, false, requeue);
    }
  }

  private track(message: ConsumeMessage | null): void {
    if (!message) return;
    const pending = this.handle(message);
    this.inFlight.add(pending);
    void pending.finally(() => this.inFlight.delete(pending));
  }
}

export function createSagaRabbitWorker(options: SagaRabbitWorkerOptions): SagaRabbitWorker {
  return new RabbitSagaWorker(options);
}
