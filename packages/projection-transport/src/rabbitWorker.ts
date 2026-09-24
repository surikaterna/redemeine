import type { ProjectionCommitCoordinator, ProjectionCommitCoordinatorOutcome } from '@redemeine/projection-worker-core';
import type { ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { decodeTapewormProjectionCommit } from './tapewormDecoder';
import { HistoricalNotificationRejectedError, type SourceTailPoller } from './sourceTailPoller';

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
  nack(message: RabbitDelivery, allUpTo: false, requeue: boolean): void;
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
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = false;
  private stopping: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private epoch = 0;

  constructor(private readonly options: ProjectionRabbitWorkerOptions) {
    validateOptions(options);
  }

  async start(channel: ProjectionRabbitChannel): Promise<void> {
    if (this.channel || this.stopping || this.starting) throw new Error('Projection Rabbit worker is already started or stopping.');
    const epoch = ++this.epoch;
    const work = this.begin(channel, epoch);
    this.starting = work;
    try { await work; } catch (error) {
      await this.options.sourceTail.stop();
      throw error;
    } finally { this.starting = undefined; }
  }

  private assertStarting(epoch: number): void {
    if (epoch !== this.epoch) throw new Error('Projection Rabbit worker stopped during startup.');
  }

  private async begin(channel: ProjectionRabbitChannel, epoch: number): Promise<void> {
    await this.options.initialize();
    this.assertStarting(epoch);
    await this.options.sourceTail.verifyCutover();
    this.assertStarting(epoch);
    await channel.checkQueue(this.options.queue);
    this.assertStarting(epoch);
    await channel.assertExchange(
      this.options.deadLetterExchange,
      this.options.deadLetterExchangeType ?? 'direct',
      { durable: true, arguments: this.options.deadLetterExchangeArguments ?? {} }
    );
    this.assertStarting(epoch);
    await channel.assertQueue(this.options.queue, {
      durable: true,
      deadLetterExchange: this.options.deadLetterExchange,
      ...(this.options.deadLetterRoutingKey ? { deadLetterRoutingKey: this.options.deadLetterRoutingKey } : {})
    });
    this.assertStarting(epoch);
    await this.options.sourceTail.bootstrap();
    this.assertStarting(epoch);
    await channel.prefetch(this.options.prefetch);
    this.assertStarting(epoch);
    this.options.sourceTail.start();
    this.accepting = true;
    let consumer;
    try {
      consumer = await channel.consume(this.options.queue, (message) => this.onDelivery(channel, message), { noAck: false });
      if (epoch !== this.epoch) {
        await channel.cancel(consumer.consumerTag);
        throw new Error('Projection Rabbit worker stopped during consume.');
      }
    } catch (error) {
      this.accepting = false;
      await Promise.allSettled([...this.inFlight]);
      await this.options.sourceTail.stop();
      throw error;
    }
    this.channel = channel;
    this.consumerTag = consumer.consumerTag;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.epoch += 1;
    this.accepting = false;
    const channel = this.channel;
    const consumerTag = this.consumerTag;
    this.channel = undefined;
    this.consumerTag = undefined;
    const work = Promise.resolve().then(async () => {
      try {
        if (this.starting) {
          await this.options.sourceTail.stop();
          await Promise.allSettled([this.starting]);
        }
        if (channel && consumerTag) await channel.cancel(consumerTag);
      } finally {
        await Promise.allSettled([...this.inFlight]);
        await this.options.sourceTail.stop();
      }
    });
    this.stopping = work;
    try { await work; } finally { this.stopping = undefined; }
  }

  private onDelivery(channel: ProjectionRabbitChannel, message: RabbitDelivery | null): void {
    if (message === null) {
      this.accepting = false;
      this.channel = undefined;
      this.consumerTag = undefined;
      void this.notifyCancellation();
      return;
    }
    const task = this.handle(channel, message).catch((error: unknown) => this.observe({ kind: 'settlement_uncertain',
      deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : 'Unexpected delivery failure.' }));
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private async handle(channel: ProjectionRabbitChannel, message: RabbitDelivery): Promise<void> {
    if (this.attempted.has(message)) return;
    this.attempted.add(message);
    if (!this.accepting) {
      this.requeueStopped(channel, message);
      return;
    }
    if (!this.options.sourceTail.isHealthy()) {
      await this.retry(channel, message, 'Indexed source tail is unavailable.');
      return;
    }
    const commit = await this.decode(channel, message);
    if (!commit) return;
    let outcome: ProjectionCommitCoordinatorOutcome;
    try {
      const resolved = await this.options.sourceTail.resolveNotification(commit);
      if (!this.accepting) {
        this.requeueStopped(channel, message);
        return;
      }
      outcome = await this.options.coordinator.process(resolved.commit);
    } catch (error) {
      if (!this.accepting) {
        this.requeueStopped(channel, message);
        return;
      }
      if (error instanceof HistoricalNotificationRejectedError) {
        await this.nack(channel, message, 'permanent', error.reason);
        return;
      }
      await this.retry(channel, message, error instanceof Error ? error.message : 'Coordinator failed.');
      return;
    }
    if (outcome.status === 'completed' && !this.options.sourceTail.isHealthy()) {
      await this.retry(channel, message, 'Indexed source tail became unavailable before ACK.');
    } else if (outcome.status === 'completed') await this.ack(channel, message);
    else if (outcome.status === 'terminal') await this.nack(channel, message, 'permanent', outcome.reason);
    else await this.retry(channel, message, outcome.reason);
  }

  private async decode(channel: ProjectionRabbitChannel, message: RabbitDelivery): Promise<ProjectionSourceCommit | null> {
    if (message.content.byteLength > this.options.maxMessageBytes) {
      await this.nack(channel, message, 'permanent', 'Rabbit message exceeds maxMessageBytes.');
      return null;
    }
    let wire: unknown;
    try {
      wire = parseWire(message.content);
    } catch {
      await this.nack(channel, message, 'permanent', 'Rabbit message is not valid JSON.');
      return null;
    }
    const decoded = decodeTapewormProjectionCommit(wire, message.properties.messageId);
    if (decoded.status === 'malformed') {
      await this.nack(channel, message, 'permanent', decoded.reason);
      return null;
    }
    return decoded.commit;
  }

  private requeueStopped(channel: ProjectionRabbitChannel, message: RabbitDelivery): void {
    try {
      channel.nack(message, false, true);
      void this.observe({ kind: 'retry', deliveryTag: message.fields.deliveryTag, reason: 'worker_stopping_before_dispatch' });
    } catch {
      void this.observe({ kind: 'settlement_uncertain', deliveryTag: message.fields.deliveryTag,
        reason: 'Worker stopped before dispatch; broker must redeliver on channel close.' });
    }
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
      void this.observe({ kind: 'ack', deliveryTag: message.fields.deliveryTag });
    } catch (error) {
      void this.observe({ kind: 'ack_uncertain', deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : 'ACK outcome unknown.' });
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
      void this.observe({ kind, deliveryTag: message.fields.deliveryTag, reason });
    } catch (error) {
      void this.observe({ kind: 'settlement_uncertain', deliveryTag: message.fields.deliveryTag, reason: error instanceof Error ? error.message : reason });
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
      await this.stop();
      await this.options.onConsumerCancelled?.();
    } catch {
      // The reconnect owner observes channel lifecycle independently.
    }
  }
}
