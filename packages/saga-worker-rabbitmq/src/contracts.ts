import type {
  CompiledSagaRoutingTable,
  SagaTurnProcessorOptions,
  SagaTurnRepository,
  SagaTurnRouteOutcome,
  SagaTurnSourceEvent
} from '@redemeine/saga-runtime';
import { assertIssuedSagaRegistration, processSagaSourceEvent } from '@redemeine/saga-runtime';
import type { Channel, ConsumeMessage, Options } from 'amqplib';

export type SagaRabbitChannel = Pick<
  Channel,
  'ack' | 'assertExchange' | 'assertQueue' | 'cancel' | 'consume' | 'nack' | 'prefetch'
>;

export interface SagaRabbitExchangeConfig {
  readonly name: string;
  readonly type: string;
  readonly options: Readonly<Options.AssertExchange> & {
    readonly durable: boolean;
    readonly autoDelete: boolean;
  };
}

export interface SagaRabbitQueueConfig {
  readonly queue: string;
  readonly options: Readonly<Options.AssertQueue> & {
    readonly durable: boolean;
    readonly autoDelete: boolean;
    readonly exclusive: boolean;
    readonly deadLetterExchange: string;
    readonly deadLetterRoutingKey: string;
  };
  readonly deadLetterExchange: SagaRabbitExchangeConfig;
}

export interface SagaRabbitSourceScope {
  readonly collection: string;
  readonly partitions: readonly string[];
}

export interface SagaRabbitWorkerLimits {
  readonly maxBodyBytes: number;
  readonly maxEvents: number;
  readonly prefetch: number;
  readonly shutdownTimeoutMs: number;
}

export type SagaRabbitWorkerState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface SagaRabbitSettlementError {
  readonly error: unknown;
  readonly message: ConsumeMessage;
  readonly settlement: 'ack' | 'nack';
  readonly requeue?: boolean;
}

export type SagaSourceEventProcessor = (source: SagaTurnSourceEvent) => Promise<readonly SagaTurnRouteOutcome[]>;

export interface SagaRabbitWorkerOptions {
  readonly channel: SagaRabbitChannel;
  readonly queue: SagaRabbitQueueConfig;
  readonly source: SagaRabbitSourceScope;
  readonly limits: SagaRabbitWorkerLimits;
  readonly processEvent: SagaSourceEventProcessor;
  readonly onSettlementError: (failure: SagaRabbitSettlementError) => void | Promise<void>;
}

export interface SagaRabbitWorker {
  readonly state: SagaRabbitWorkerState;
  start(): Promise<string>;
  stop(): Promise<void>;
  handle(message: ConsumeMessage): Promise<void>;
}

export function createSagaSourceEventProcessor(
  table: CompiledSagaRoutingTable,
  repository: SagaTurnRepository,
  options: SagaTurnProcessorOptions
): SagaSourceEventProcessor {
  if (!options || typeof options.registrationForRoute !== 'function') throw new TypeError('Saga worker requires registrations');
  if (!table.registered || table.registered.length !== table.definitions.length) {
    throw new TypeError('Saga worker requires a compiled executable registration table');
  }
  for (const route of table.routes) {
    const registration = options.registrationForRoute(route);
    assertIssuedSagaRegistration(registration);
    if (registration.definition !== route.definition || registration.sagaKey !== route.sagaKey ||
        registration.definitionVersion !== route.definitionVersion ||
        !table.registered.includes(registration) ||
        (route.kind === 'start' && (!route.executeStart || route.executeStart !== registration.executeStart)) ||
        (route.kind === 'on' && !route.executeOn)) {
      throw new TypeError('Saga worker requires matching executable start registration');
    }
  }
  return (source) => processSagaSourceEvent(table, repository, source, options);
}
