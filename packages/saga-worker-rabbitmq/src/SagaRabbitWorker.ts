import { SagaTurnError } from '@redemeine/saga-runtime';
import type { ConsumeMessage } from 'amqplib';
import type {
  SagaRabbitSettlementError,
  SagaRabbitWorker,
  SagaRabbitWorkerOptions,
  SagaRabbitWorkerState
} from './contracts';
import { decodeSagaRabbitMessage } from './decodeMessage';

type Settlement = { readonly type: 'ack' } | { readonly type: 'nack'; readonly requeue: boolean };

class StartInterruptedError extends Error {
  constructor() {
    super('Rabbit saga worker start was interrupted');
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
}

function assertConfiguration(options: SagaRabbitWorkerOptions): void {
  const { queue, limits, source } = options;
  if (queue.queue.length === 0) throw new TypeError('queue must not be empty');
  if (queue.deadLetterExchange.name.length === 0) throw new TypeError('dead-letter exchange must not be empty');
  if (queue.deadLetterExchange.type.length === 0) throw new TypeError('dead-letter exchange type must not be empty');
  const explicitBooleans = [
    queue.options.durable,
    queue.options.autoDelete,
    queue.options.exclusive,
    queue.deadLetterExchange.options.durable,
    queue.deadLetterExchange.options.autoDelete
  ];
  if (explicitBooleans.some((value) => typeof value !== 'boolean')) {
    throw new TypeError('queue and dead-letter exchange declaration booleans must be explicit');
  }
  if (queue.options.deadLetterExchange !== queue.deadLetterExchange.name) {
    throw new TypeError('queue dead-letter exchange must match its declared exchange');
  }
  if (queue.options.deadLetterRoutingKey.length === 0) throw new TypeError('dead-letter routing key must not be empty');
  if (source.collection.length === 0) throw new TypeError('source collection must not be empty');
  if (source.partitions.length === 0 || source.partitions.some((value) => value.length === 0)) {
    throw new TypeError('source partitions must contain non-empty values');
  }
  if (typeof options.onSettlementError !== 'function') throw new TypeError('onSettlementError must be a function');
  positiveInteger(limits.maxBodyBytes, 'maxBodyBytes');
  positiveInteger(limits.maxEvents, 'maxEvents');
  positiveInteger(limits.prefetch, 'prefetch');
  positiveInteger(limits.shutdownTimeoutMs, 'shutdownTimeoutMs');
}

class RabbitSagaWorker implements SagaRabbitWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private stateValue: SagaRabbitWorkerState = 'stopped';
  private generation = 0;
  private brokerCancelledGeneration: number | null = null;
  private activeConsumer: { readonly tag: string; readonly generation: number } | null = null;
  private startPromise: Promise<string> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: SagaRabbitWorkerOptions) {}

  get state(): SagaRabbitWorkerState {
    return this.stateValue;
  }

  start(): Promise<string> {
    if (this.stateValue === 'running' && this.activeConsumer) return Promise.resolve(this.activeConsumer.tag);
    if (this.stateValue === 'starting' && this.startPromise) return this.startPromise;
    if (this.stateValue === 'stopping' && this.stopPromise) return this.stopPromise.then(() => this.start());
    try {
      assertConfiguration(this.options);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = ++this.generation;
    this.stateValue = 'starting';
    const started = this.startGeneration(generation);
    const observed = started.finally(() => {
      if (this.startPromise === observed) this.startPromise = null;
    });
    this.startPromise = observed;
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stateValue === 'stopping' && this.stopPromise) return this.stopPromise;
    if (this.stateValue === 'stopped') return this.drainInFlight();
    const active = this.activeConsumer;
    const starting = this.startPromise;
    this.activeConsumer = null;
    this.stateValue = 'stopping';
    ++this.generation;
    this.stopPromise = this.stopGeneration(active?.tag, starting);
    return this.stopPromise;
  }

  async handle(message: ConsumeMessage): Promise<void> {
    const settlement = await this.determineSettlement(message);
    await this.settle(message, settlement);
  }

  private async startGeneration(generation: number): Promise<string> {
    try {
      await this.declareTopology(generation);
      const reply = await this.options.channel.consume(
        this.options.queue.queue,
        (message) => this.onDelivery(generation, message),
        { noAck: false }
      );
      if (this.brokerCancelledGeneration === generation) throw new StartInterruptedError();
      if (!this.isStarting(generation)) {
        await this.options.channel.cancel(reply.consumerTag);
        throw new StartInterruptedError();
      }
      this.activeConsumer = { tag: reply.consumerTag, generation };
      this.stateValue = 'running';
      return reply.consumerTag;
    } catch (error) {
      if (this.isStarting(generation)) this.stateValue = 'stopped';
      throw error;
    }
  }

  private async declareTopology(generation: number): Promise<void> {
    const { channel, queue } = this.options;
    const exchange = await channel.assertExchange(
      queue.deadLetterExchange.name,
      queue.deadLetterExchange.type,
      queue.deadLetterExchange.options
    );
    if (exchange.exchange !== queue.deadLetterExchange.name) throw new Error('asserted dead-letter exchange name mismatch');
    this.requireStarting(generation);
    const assertedQueue = await channel.assertQueue(queue.queue, queue.options);
    if (assertedQueue.queue !== queue.queue) throw new Error('asserted queue name mismatch');
    this.requireStarting(generation);
    await channel.prefetch(this.options.limits.prefetch, false);
    this.requireStarting(generation);
  }

  private async stopGeneration(tag: string | undefined, starting: Promise<string> | null): Promise<void> {
    let cancelError: unknown;
    try {
      if (tag) await this.options.channel.cancel(tag);
    } catch (error) {
      cancelError = error;
    }
    if (starting) await starting.catch(() => undefined);
    try {
      await this.drainInFlight();
      if (cancelError !== undefined) throw cancelError;
    } finally {
      this.stateValue = 'stopped';
      this.stopPromise = null;
    }
  }

  private async drainInFlight(): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out draining Rabbit saga deliveries')), this.options.limits.shutdownTimeoutMs);
    });
    try {
      await Promise.race([Promise.all([...this.inFlight]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async determineSettlement(message: ConsumeMessage): Promise<Settlement> {
    try {
      const events = decodeSagaRabbitMessage(message, this.options.source, this.options.limits);
      for (const event of events) await this.options.processEvent(event);
      return { type: 'ack' };
    } catch (error) {
      return { type: 'nack', requeue: error instanceof SagaTurnError ? error.retryable : true };
    }
  }

  private settle(message: ConsumeMessage, settlement: Settlement): void | Promise<never> {
    try {
      if (settlement.type === 'ack') this.options.channel.ack(message, false);
      else this.options.channel.nack(message, false, settlement.requeue);
    } catch (error) {
      return this.reportSettlementError({
        error,
        message,
        settlement: settlement.type,
        ...(settlement.type === 'nack' ? { requeue: settlement.requeue } : {})
      }, error);
    }
  }

  private async reportSettlementError(failure: SagaRabbitSettlementError, channelError: unknown): Promise<never> {
    try {
      await this.options.onSettlementError(failure);
    } catch {
      // Observer failures are contained so the original channel failure remains authoritative.
    }
    throw channelError;
  }

  private onDelivery(generation: number, message: ConsumeMessage | null): void {
    if (!message) {
      this.onBrokerCancellation(generation);
      return;
    }
    if (!this.acceptsDelivery(generation) || this.inFlight.size >= this.options.limits.prefetch) {
      const failedSettlement = this.settle(message, { type: 'nack', requeue: true });
      if (failedSettlement) this.trackTask(failedSettlement);
      return;
    }
    this.trackTask(this.handle(message));
  }

  private trackTask(task: Promise<void>): void {
    let pending: Promise<void> | undefined;
    pending = this.runTracked(task, () => {
      if (pending) this.inFlight.delete(pending);
    });
    this.inFlight.add(pending);
  }

  private async runTracked(task: Promise<void>, finalize: () => void): Promise<void> {
    try {
      await task;
    } catch {
      // handle reports settlement failures; processing failures become NACK dispositions.
    } finally {
      finalize();
    }
  }

  private onBrokerCancellation(generation: number): void {
    if (generation !== this.generation) return;
    this.brokerCancelledGeneration = generation;
    this.activeConsumer = null;
    this.stateValue = 'stopped';
    ++this.generation;
  }

  private acceptsDelivery(generation: number): boolean {
    return generation === this.generation && (this.stateValue === 'starting' || this.stateValue === 'running');
  }

  private isStarting(generation: number): boolean {
    return generation === this.generation && this.stateValue === 'starting';
  }

  private requireStarting(generation: number): void {
    if (!this.isStarting(generation)) throw new StartInterruptedError();
  }
}

export function createSagaRabbitWorker(options: SagaRabbitWorkerOptions): SagaRabbitWorker {
  return new RabbitSagaWorker(options);
}
