import type { SagaCommandMap, SagaIntent, SagaReducerOutput } from './createSaga';
import { computeNextAttemptAt, type RetrySchedulingNow, type SagaRetryPolicy } from './RetryPolicy';

export interface SagaIntentRecordedEvent<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly type: 'saga.intent-recorded';
  readonly sagaStreamId: string;
  readonly idempotencyKey: string;
  readonly intent: SagaIntent<TCommandMap>;
  readonly recordedAt: string;
}

export interface SagaIntentLifecycleContext {
  readonly intentKey: string;
  readonly metadata: {
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
}

export interface SagaIntentStartedEvent {
  readonly type: 'saga.intent-started';
  readonly sagaStreamId: string;
  readonly lifecycle: SagaIntentLifecycleContext;
  readonly startedAt: string;
}

export interface SagaIntentSucceededEvent {
  readonly type: 'saga.intent-succeeded';
  readonly sagaStreamId: string;
  readonly lifecycle: SagaIntentLifecycleContext;
  readonly succeededAt: string;
}

export interface SagaIntentDispatchedEvent {
  readonly type: 'saga.intent-dispatched';
  readonly sagaStreamId: string;
  readonly lifecycle: SagaIntentLifecycleContext;
  readonly dispatchedAt: string;
}

export interface SagaIntentFailedEvent {
  readonly type: 'saga.intent-failed';
  readonly sagaStreamId: string;
  readonly lifecycle: SagaIntentLifecycleContext;
  readonly failedAt: string;
}

export interface SagaIntentRetryScheduledEvent {
  readonly type: 'saga.intent-retry-scheduled';
  readonly sagaStreamId: string;
  readonly lifecycle: SagaIntentLifecycleContext;
  readonly retry: {
    readonly attempt: number;
    readonly nextAttemptAt: string;
  };
  readonly scheduledAt: string;
}

export type SagaLifecycleEvent =
  | SagaIntentStartedEvent
  | SagaIntentDispatchedEvent
  | SagaIntentSucceededEvent
  | SagaIntentFailedEvent
  | SagaIntentRetryScheduledEvent;

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);

  return `{${entries.join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createSagaIntentIdempotencyKey<TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  intentOrdinal: number,
  intent: SagaIntent<TCommandMap>
): string {
  const intentHash = hashString(stableSerialize(intent));
  return `${sagaStreamId}:${intentOrdinal}:${intentHash}`;
}
export interface SagaEventStore {
  appendIntentRecordedBatch<TCommandMap extends SagaCommandMap>(
    sagaStreamId: string,
    events: readonly SagaIntentRecordedEvent<TCommandMap>[]
  ): Promise<void>;
  appendLifecycleEvent(sagaStreamId: string, event: SagaLifecycleEvent): Promise<void>;
}

export type SagaIntentRecordedWriter = Pick<SagaEventStore, 'appendIntentRecordedBatch'>;
export type SagaLifecycleEventWriter = Pick<SagaEventStore, 'appendLifecycleEvent'>;

export class InMemorySagaEventStore implements SagaEventStore {
  private readonly streams = new Map<string, SagaIntentRecordedEvent[]>();
  private readonly lifecycleStreams = new Map<string, SagaLifecycleEvent[]>();

  async appendIntentRecordedBatch<TCommandMap extends SagaCommandMap>(
    sagaStreamId: string,
    events: readonly SagaIntentRecordedEvent<TCommandMap>[]
  ): Promise<void> {
    const existing = this.streams.get(sagaStreamId) ?? [];

    this.streams.set(sagaStreamId, [
      ...existing,
      ...(events as readonly SagaIntentRecordedEvent[])
    ]);
  }

  async appendLifecycleEvent(sagaStreamId: string, event: SagaLifecycleEvent): Promise<void> {
    const existing = this.lifecycleStreams.get(sagaStreamId) ?? [];
    this.lifecycleStreams.set(sagaStreamId, [...existing, event]);
  }

  async loadIntentRecordedEvents(
    sagaStreamId: string
  ): Promise<readonly SagaIntentRecordedEvent[]> {
    const events = this.streams.get(sagaStreamId) ?? [];
    return [...events];
  }

  async loadLifecycleEvents(sagaStreamId: string): Promise<readonly SagaLifecycleEvent[]> {
    const events = this.lifecycleStreams.get(sagaStreamId) ?? [];
    return [...events];
  }

  clear(): void {
    this.streams.clear();
    this.lifecycleStreams.clear();
  }
}

export interface SagaIntentLifecycleAppendInput {
  readonly sagaStreamId: string;
  readonly intentKey: string;
  readonly metadata: {
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
}

export interface SagaIntentRetryScheduledAppendInput extends SagaIntentLifecycleAppendInput {
  readonly attempt: number;
  readonly nextAttemptAt: string;
}

export interface SagaIntentRetryFromPolicyAppendInput extends SagaIntentLifecycleAppendInput {
  readonly policy: SagaRetryPolicy;
  readonly attempt: number;
  readonly now: RetrySchedulingNow;
  readonly jitter?: number;
}

export function createSagaIntentStartedEvent(
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentStartedEvent {
  return {
    type: 'saga.intent-started',
    sagaStreamId: input.sagaStreamId,
    lifecycle: {
      intentKey: input.intentKey,
      metadata: input.metadata
    },
    startedAt: createTimestamp()
  };
}

export function createSagaIntentSucceededEvent(
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentSucceededEvent {
  return {
    type: 'saga.intent-succeeded',
    sagaStreamId: input.sagaStreamId,
    lifecycle: {
      intentKey: input.intentKey,
      metadata: input.metadata
    },
    succeededAt: createTimestamp()
  };
}

export function createSagaIntentDispatchedEvent(
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentDispatchedEvent {
  return {
    type: 'saga.intent-dispatched',
    sagaStreamId: input.sagaStreamId,
    lifecycle: {
      intentKey: input.intentKey,
      metadata: input.metadata
    },
    dispatchedAt: createTimestamp()
  };
}

export function createSagaIntentFailedEvent(
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentFailedEvent {
  return {
    type: 'saga.intent-failed',
    sagaStreamId: input.sagaStreamId,
    lifecycle: {
      intentKey: input.intentKey,
      metadata: input.metadata
    },
    failedAt: createTimestamp()
  };
}

export function createSagaIntentRetryScheduledEvent(
  input: SagaIntentRetryScheduledAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentRetryScheduledEvent {
  return {
    type: 'saga.intent-retry-scheduled',
    sagaStreamId: input.sagaStreamId,
    lifecycle: {
      intentKey: input.intentKey,
      metadata: input.metadata
    },
    retry: {
      attempt: input.attempt,
      nextAttemptAt: input.nextAttemptAt
    },
    scheduledAt: createTimestamp()
  };
}

export function createSagaIntentRetryScheduledEventFromPolicy(
  input: SagaIntentRetryFromPolicyAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): SagaIntentRetryScheduledEvent {
  return createSagaIntentRetryScheduledEvent(
    {
      sagaStreamId: input.sagaStreamId,
      intentKey: input.intentKey,
      metadata: input.metadata,
      attempt: input.attempt,
      nextAttemptAt: computeNextAttemptAt(input.policy, input.attempt, input.now, input.jitter)
    },
    createTimestamp
  );
}

export async function appendSagaIntentStartedEvent(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentStartedEvent> {
  const event = createSagaIntentStartedEvent(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export async function appendSagaIntentSucceededEvent(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentSucceededEvent> {
  const event = createSagaIntentSucceededEvent(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export async function appendSagaIntentDispatchedEvent(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentDispatchedEvent> {
  const event = createSagaIntentDispatchedEvent(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export async function appendSagaIntentFailedEvent(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentLifecycleAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentFailedEvent> {
  const event = createSagaIntentFailedEvent(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export async function appendSagaIntentRetryScheduledEvent(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentRetryScheduledAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentRetryScheduledEvent> {
  const event = createSagaIntentRetryScheduledEvent(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export async function appendSagaIntentRetryScheduledEventFromPolicy(
  eventStore: SagaLifecycleEventWriter,
  input: SagaIntentRetryFromPolicyAppendInput,
  createTimestamp: () => string = () => new Date().toISOString()
): Promise<SagaIntentRetryScheduledEvent> {
  const event = createSagaIntentRetryScheduledEventFromPolicy(input, createTimestamp);
  await eventStore.appendLifecycleEvent(input.sagaStreamId, event);
  return event;
}

export function createSagaIntentRecordedEvents<TState, TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  output: SagaReducerOutput<TState, TCommandMap>,
  createRecordedAt: () => string = () => new Date().toISOString()
): SagaIntentRecordedEvent<TCommandMap>[] {
  return output.intents.map((intent, intentOrdinal) => ({
    type: 'saga.intent-recorded',
    sagaStreamId,
    idempotencyKey: createSagaIntentIdempotencyKey(sagaStreamId, intentOrdinal, intent),
    intent,
    recordedAt: createRecordedAt()
  }));
}

export async function persistSagaReducerOutputIntents<TState, TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  output: SagaReducerOutput<TState, TCommandMap>,
  eventStore: SagaIntentRecordedWriter,
  createRecordedAt: () => string = () => new Date().toISOString()
): Promise<readonly SagaIntentRecordedEvent<TCommandMap>[]> {
  const events = createSagaIntentRecordedEvents(sagaStreamId, output, createRecordedAt);
  await eventStore.appendIntentRecordedBatch(sagaStreamId, events);
  return events;
}
