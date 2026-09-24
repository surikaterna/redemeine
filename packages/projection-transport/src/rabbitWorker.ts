import type { ProjectionCommitCoordinator, ProjectionCommitCoordinatorOutcome } from '@redemeine/projection-worker-core';
import { decodeTapewormProjectionCommit } from './tapewormDecoder';
import type { SourceTailPoller } from './sourceTailPoller';

export interface RabbitDelivery {
  readonly content: Buffer;
  readonly fields: { readonly deliveryTag: number; readonly redelivered: boolean };
  readonly properties: { readonly messageId?: string };
}

export interface ProjectionRabbitChannel {
  checkQueue(queue: string): Promise<unknown>;
  assertExchange(exchange: string, type: string, options: {
    durable: true;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  assertQueue(queue: string, options: {
    durable: true;
    deadLetterExchange: string;
    deadLetterRoutingKey?: string;
  }): Promise<unknown>;
  prefetch(count: number): Promise<unknown>;
  consume(
    queue: string,
    handler: (message: RabbitDelivery | null) => void,
    options: { noAck: false }
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  ack(message: RabbitDelivery): void;
  nack(message: RabbitDelivery, allUpTo: false, requeue: false): void;
}

export type RabbitSettlementKind = 'ack' | 'ack_uncertain' | 'retry' | 'permanent' | 'settlement_uncertain';

export interface RabbitSettlementEvent {
  readonly kind: RabbitSettlementKind;
  readonly deliveryTag: number;
  readonly reason?: string;
}

export interface ProjectionRabbitRetryReceipt {
  readonly durable: true;
  readonly notBeforeEpochMs: number;
}

export interface ProjectionRabbitWorkerOptions {
  readonly queue: string;
  readonly deadLetterExchange: string;
  readonly deadLetterExchangeType?: string;
  readonly deadLetterExchangeArguments?: Readonly<Record<string, unknown>>;
  readonly deadLetterRoutingKey?: string;
  readonly prefetch: number;
  readonly maxMessageBytes: number;
  readonly retryBackoffMs: number;
  readonly coordinator: ProjectionCommitCoordinator;
  readonly initialize: () => Promise<void>;
  readonly sourceTail: SourceTailPoller;
  /** Must durably arrange broker-side delayed redelivery before resolving. */
  readonly scheduleRetry: (
    message: RabbitDelivery,
    reason: string,
    minimumDelayMs: number
  ) => Promise<ProjectionRabbitRetryReceipt>;
  readonly now?: () => number;
  readonly observeSettlement?: (event: RabbitSettlementEvent) => Promise<void> | void;
  readonly onConsumerCancelled?: () => Promise<void> | void;
}

function validateOptions(options: ProjectionRabbitWorkerOptions): void {
  if (!options.sourceTail) throw new Error('Indexed source-tail poller is required before Rabbit consumption.');
  if (!options.queue || !options.deadLetterExchange) throw new Error('Queue and dead-letter exchange are required.');
  if (!Number.isSafeInteger(options.prefetch) || options.prefetch <= 0) throw new Error('prefetch must be positive.');
  if (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes <= 0) throw new Error('maxMessageBytes must be positive.');
  if (!Number.isSafeInteger(options.retryBackoffMs) || options.retryBackoffMs <= 0) throw new Error('retryBackoffMs must be positive.');
}

function parseWire(content: Buffer): unknown {
  return JSON.parse(content.toString('utf8'));
}

export class ProjectionRabbitWorker {
  private channel: ProjectionRabbitChannel | undefined;
  private consumerTag: string | undefined;
  private readonly attempted = new WeakSet<object>();

  constructor(private readonly options: ProjectionRabbitWorkerOptions) {
    validateOptions(options);
  }

  async start(channel: ProjectionRabbitChannel): Promise<void> {
    if (this.channel) throw new Error('Projection Rabbit worker is already started.');
    await this.options.initialize();
    await channel.checkQueue(this.options.queue);
    await channel.assertExchange(
      this.options.deadLetterExchange,
      this.options.deadLetterExchangeType ?? 'direct',
      { durable: true, arguments: this.options.deadLetterExchangeArguments ?? {} }
    );
    await channel.assertQueue(this.options.queue, {
      durable: true,
      deadLetterExchange: this.options.deadLetterExchange,
      ...(this.options.deadLetterRoutingKey ? { deadLetterRoutingKey: this.options.deadLetterRoutingKey } : {})
    });
    await this.options.sourceTail.bootstrap();
    await channel.prefetch(this.options.prefetch);
    this.options.sourceTail.start();
    let consumer;
    try {
      consumer = await channel.consume(this.options.queue, (message) => {
      if (message === null) {
        this.channel = undefined;
        this.consumerTag = undefined;
        void this.notifyCancellation();
        return;
      }
      void this.handle(channel, message);
      }, { noAck: false });
    } catch (error) {
      await this.options.sourceTail.stop();
      throw error;
    }
    this.channel = channel;
    this.consumerTag = consumer.consumerTag;
  }

  async stop(): Promise<void> {
    const channel = this.channel;
    const consumerTag = this.consumerTag;
    this.channel = undefined;
    this.consumerTag = undefined;
    if (channel && consumerTag) await channel.cancel(consumerTag);
    await this.options.sourceTail.stop();
  }

  private async handle(channel: ProjectionRabbitChannel, message: RabbitDelivery): Promise<void> {
    if (this.attempted.has(message)) return;
    this.attempted.add(message);
    if (!this.options.sourceTail.isHealthy()) {
      await this.retry(channel, message, 'Indexed source tail is unavailable.');
      return;
    }
    if (message.content.byteLength > this.options.maxMessageBytes) {
      await this.nack(channel, message, 'permanent', 'Rabbit message exceeds maxMessageBytes.');
      return;
    }
    let wire: unknown;
    try {
      wire = parseWire(message.content);
    } catch {
      await this.nack(channel, message, 'permanent', 'Rabbit message is not valid JSON.');
      return;
    }
    const decoded = decodeTapewormProjectionCommit(wire, message.properties.messageId);
    if (decoded.status === 'malformed') {
      await this.nack(channel, message, 'permanent', decoded.reason);
      return;
    }
    let outcome: ProjectionCommitCoordinatorOutcome;
    try {
      outcome = await this.options.coordinator.process(decoded.commit);
    } catch (error) {
      await this.retry(channel, message, error instanceof Error ? error.message : 'Coordinator failed.');
      return;
    }
    if (outcome.status === 'completed' && !this.options.sourceTail.isHealthy()) {
      await this.retry(channel, message, 'Indexed source tail became unavailable before ACK.');
    } else if (outcome.status === 'completed') await this.ack(channel, message);
    else if (outcome.status === 'terminal') await this.nack(channel, message, 'permanent', outcome.reason);
    else await this.retry(channel, message, outcome.reason);
  }

  private async retry(channel: ProjectionRabbitChannel, message: RabbitDelivery, reason: string): Promise<void> {
    const earliest = (this.options.now?.() ?? Date.now()) + this.options.retryBackoffMs;
    try {
      const receipt = await this.options.scheduleRetry(message, reason, this.options.retryBackoffMs);
      if (receipt.durable !== true || receipt.notBeforeEpochMs < earliest) {
        throw new Error('Retry publisher did not confirm durable bounded backoff.');
      }
    } catch (error) {
      await this.observe({ kind: 'settlement_uncertain', deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : reason });
      return;
    }
    await this.nack(channel, message, 'retry', reason);
  }

  private async ack(channel: ProjectionRabbitChannel, message: RabbitDelivery): Promise<void> {
    try {
      channel.ack(message);
      await this.observe({ kind: 'ack', deliveryTag: message.fields.deliveryTag });
    } catch (error) {
      await this.observe({ kind: 'ack_uncertain', deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : 'ACK outcome unknown.' });
    }
  }

  private async nack(
    channel: ProjectionRabbitChannel,
    message: RabbitDelivery,
    kind: 'retry' | 'permanent',
    reason: string
  ): Promise<void> {
    try {
      channel.nack(message, false, false);
      await this.observe({ kind, deliveryTag: message.fields.deliveryTag, reason });
    } catch (error) {
      await this.observe({ kind: 'settlement_uncertain', deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : reason });
    }
  }

  private async observe(event: RabbitSettlementEvent): Promise<void> {
    try {
      await this.options.observeSettlement?.(event);
    } catch {
      // Settlement observation cannot trigger a second broker settlement.
    }
  }

  private async notifyCancellation(): Promise<void> {
    try {
      await this.options.sourceTail.stop();
      await this.options.onConsumerCancelled?.();
    } catch {
      // The reconnect owner observes channel lifecycle independently.
    }
  }
}
