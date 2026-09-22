import type {
  CompiledSagaRoutingTable,
  SagaTurnProcessorOptions,
  SagaTurnRepository,
  SagaTurnRouteOutcome,
  SagaTurnSourceEvent
} from '@redemeine/saga-runtime';
import { processSagaSourceEvent } from '@redemeine/saga-runtime';
import type { Channel, ConsumeMessage } from 'amqplib';

export type SagaRabbitChannel = Pick<Channel, 'consume' | 'cancel' | 'ack' | 'nack'>;

export interface SagaRabbitQueueConfig {
  readonly queue: string;
  readonly deadLetterExchange: string;
  readonly deadLetterConfigured: boolean;
}

export type SagaSourceEventProcessor = (source: SagaTurnSourceEvent) => Promise<readonly SagaTurnRouteOutcome[]>;

export interface SagaRabbitWorkerOptions {
  readonly channel: SagaRabbitChannel;
  readonly queue: SagaRabbitQueueConfig;
  readonly processEvent: SagaSourceEventProcessor;
}

export interface SagaRabbitWorker {
  start(): Promise<string>;
  stop(): Promise<void>;
  handle(message: ConsumeMessage): Promise<void>;
}

export function createSagaSourceEventProcessor(
  table: CompiledSagaRoutingTable,
  repository: SagaTurnRepository,
  options: SagaTurnProcessorOptions = {}
): SagaSourceEventProcessor {
  return (source) => processSagaSourceEvent(table, repository, source, options);
}
