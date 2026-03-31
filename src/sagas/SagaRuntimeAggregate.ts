import { createAggregate } from '../createAggregate';
import type { Event } from '../types';
import type { ReadonlyDeep } from '../utils/types/ReadonlyDeep';

export const SAGA_RUNTIME_COMMAND_TAXONOMY = [
  'observeEvent',
  'queueIntent',
  'startIntent',
  'completeIntent',
  'failIntent',
  'scheduleRetry',
  'deadLetterIntent'
] as const;

export type SagaRuntimeCommandName = (typeof SAGA_RUNTIME_COMMAND_TAXONOMY)[number];

export const SAGA_RUNTIME_EVENT_TAXONOMY = [
  'eventObserved',
  'started',
  'intentQueued',
  'intentStarted',
  'intentCompleted',
  'intentFailed',
  'intentRetryScheduled',
  'intentDeadLettered'
] as const;

export type SagaRuntimeEventName = (typeof SAGA_RUNTIME_EVENT_TAXONOMY)[number];

export interface SagaRuntimeState {
  lifecycle: 'idle' | 'active';
  sagaInstanceKey: string | null;
  correlationId: string | null;
  startedAt: string | null;
  observedCount: number;
  lastObservedAt: string | null;
  activeIntentKey: string | null;
  intents: Record<string, SagaRuntimeIntentState>;
  completedIntentKeys: string[];
  deadLetteredIntentKeys: string[];
}

export interface SagaRuntimeIntentState {
  readonly intentKey: string;
  readonly idempotencyKey: string | null;
  readonly metadata: {
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  } | null;
  readonly intentType: string;
  readonly status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'retry_scheduled' | 'dead_lettered';
  readonly attempts: number;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly scheduledRetryAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly deadLetteredAt: string | null;
  readonly lastErrorMessage: string | null;
  readonly deadLetterReason: 'non-retryable' | 'max-attempts-exhausted' | null;
}

export interface SagaRuntimeObserveEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly isStart: boolean;
  readonly observedAt: string;
}

export interface SagaRuntimeObservedEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly sagaInstanceKey: string;
  readonly isStart: boolean;
  readonly observedAt: string;
}

export interface SagaRuntimeStartedEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly sagaInstanceKey: string;
  readonly startedAt: string;
}

export interface SagaRuntimeQueueIntentPayload {
  readonly intentKey: string;
  readonly idempotencyKey: string;
  readonly metadata: {
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
  readonly intentType: string;
  readonly queuedAt: string;
}

export interface SagaRuntimeIntentQueuedEventPayload extends SagaRuntimeQueueIntentPayload {}

export interface SagaRuntimeStartIntentPayload {
  readonly intentKey: string;
  readonly startedAt: string;
}

export interface SagaRuntimeIntentStartedEventPayload extends SagaRuntimeStartIntentPayload {}

export interface SagaRuntimeCompleteIntentPayload {
  readonly intentKey: string;
  readonly completedAt: string;
}

export interface SagaRuntimeIntentCompletedEventPayload extends SagaRuntimeCompleteIntentPayload {}

export interface SagaRuntimeFailIntentPayload {
  readonly intentKey: string;
  readonly failedAt: string;
  readonly errorMessage: string;
}

export interface SagaRuntimeIntentFailedEventPayload extends SagaRuntimeFailIntentPayload {}

export interface SagaRuntimeScheduleRetryPayload {
  readonly intentKey: string;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly scheduledAt: string;
}

export interface SagaRuntimeIntentRetryScheduledEventPayload extends SagaRuntimeScheduleRetryPayload {}

export interface SagaRuntimeDeadLetterIntentPayload {
  readonly intentKey: string;
  readonly attempt: number;
  readonly reason: 'non-retryable' | 'max-attempts-exhausted';
  readonly errorMessage: string;
  readonly deadLetteredAt: string;
}

export interface SagaRuntimeIntentDeadLetteredEventPayload extends SagaRuntimeDeadLetterIntentPayload {}

export function shouldActivateSagaFromObservation(
  state: ReadonlyDeep<SagaRuntimeState>,
  payload: SagaRuntimeObserveEventPayload
): boolean {
  return state.lifecycle === 'idle' && payload.isStart;
}

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

/**
 * Deterministic instance-key derivation for one saga type + correlation value.
 */
export function deriveSagaRuntimeInstanceKey(
  sagaType: string,
  correlation: unknown
): string {
  return `${sagaType}:${hashString(stableSerialize(correlation))}`;
}

const INITIAL_SAGA_RUNTIME_STATE: SagaRuntimeState = {
  lifecycle: 'idle',
  sagaInstanceKey: null,
  correlationId: null,
  startedAt: null,
  observedCount: 0,
  lastObservedAt: null,
  activeIntentKey: null,
  intents: {},
  completedIntentKeys: [],
  deadLetteredIntentKeys: []
};

function requireIntent(state: ReadonlyDeep<SagaRuntimeState>, intentKey: string): ReadonlyDeep<SagaRuntimeIntentState> {
  const intent = state.intents[intentKey];
  if (!intent) {
    throw new Error(`Unknown intent '${intentKey}'.`);
  }

  return intent;
}

function assertIntentNotTerminal(intent: ReadonlyDeep<SagaRuntimeIntentState>): void {
  if (intent.status === 'completed' || intent.status === 'dead_lettered') {
    throw new Error(`Intent '${intent.intentKey}' is terminal and cannot transition from '${intent.status}'.`);
  }
}

function pushUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

/**
 * Hidden/internal runtime aggregate contract for saga execution bookkeeping.
 */
export const SagaRuntimeAggregate = createAggregate<SagaRuntimeState, 'sagaRuntime'>('sagaRuntime', INITIAL_SAGA_RUNTIME_STATE)
  .overrideEventNames({
    intentQueued: 'sagaRuntime.intentQueued.event',
    intentStarted: 'sagaRuntime.intentStarted.event',
    intentCompleted: 'sagaRuntime.intentCompleted.event',
    intentFailed: 'sagaRuntime.intentFailed.event',
    intentRetryScheduled: 'sagaRuntime.intentRetryScheduled.event',
    intentDeadLettered: 'sagaRuntime.intentDeadLettered.event'
  })
  .events({
    eventObserved: (state, event: Event<SagaRuntimeObservedEventPayload>) => {
      state.observedCount += 1;
      state.lastObservedAt = event.payload.observedAt;
    },
    started: (state, event: Event<SagaRuntimeStartedEventPayload>) => {
      state.lifecycle = 'active';
      state.sagaInstanceKey = event.payload.sagaInstanceKey;
      state.correlationId = event.payload.correlationId;
      state.startedAt = event.payload.startedAt;
    },
    intentQueued: (state, event: Event<SagaRuntimeIntentQueuedEventPayload>) => {
      state.intents[event.payload.intentKey] = {
        intentKey: event.payload.intentKey,
        idempotencyKey: event.payload.idempotencyKey,
        metadata: event.payload.metadata,
        intentType: event.payload.intentType,
        status: 'queued',
        attempts: 0,
        queuedAt: event.payload.queuedAt,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        scheduledRetryAt: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        lastErrorMessage: null,
        deadLetterReason: null
      };
    },
    intentStarted: (state, event: Event<SagaRuntimeIntentStartedEventPayload>) => {
      const previous = state.intents[event.payload.intentKey];
      const attempts = previous ? previous.attempts + 1 : 1;

      state.intents[event.payload.intentKey] = {
        ...(previous as SagaRuntimeIntentState),
        intentKey: event.payload.intentKey,
        idempotencyKey: previous?.idempotencyKey ?? null,
        metadata: previous?.metadata ?? null,
        intentType: previous?.intentType ?? 'unknown',
        status: 'in_progress',
        attempts,
        queuedAt: previous?.queuedAt ?? event.payload.startedAt,
        startedAt: event.payload.startedAt,
        completedAt: null,
        failedAt: null,
        scheduledRetryAt: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        deadLetterReason: null,
        lastErrorMessage: null
      };
      state.activeIntentKey = event.payload.intentKey;
    },
    intentCompleted: (state, event: Event<SagaRuntimeIntentCompletedEventPayload>) => {
      const previous = state.intents[event.payload.intentKey];
      if (!previous) {
        return;
      }

      state.intents[event.payload.intentKey] = {
        ...previous,
        status: 'completed',
        completedAt: event.payload.completedAt,
        failedAt: null,
        scheduledRetryAt: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        deadLetterReason: null,
        lastErrorMessage: null
      };
      if (state.activeIntentKey === event.payload.intentKey) {
        state.activeIntentKey = null;
      }
      state.completedIntentKeys = pushUnique(state.completedIntentKeys, event.payload.intentKey);
    },
    intentFailed: (state, event: Event<SagaRuntimeIntentFailedEventPayload>) => {
      const previous = state.intents[event.payload.intentKey];
      if (!previous) {
        return;
      }

      state.intents[event.payload.intentKey] = {
        ...previous,
        status: 'failed',
        failedAt: event.payload.failedAt,
        completedAt: null,
        scheduledRetryAt: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        deadLetterReason: null,
        lastErrorMessage: event.payload.errorMessage
      };
      if (state.activeIntentKey === event.payload.intentKey) {
        state.activeIntentKey = null;
      }
    },
    intentRetryScheduled: (state, event: Event<SagaRuntimeIntentRetryScheduledEventPayload>) => {
      const previous = state.intents[event.payload.intentKey];
      if (!previous) {
        return;
      }

      state.intents[event.payload.intentKey] = {
        ...previous,
        status: 'retry_scheduled',
        attempts: event.payload.attempt,
        scheduledRetryAt: event.payload.scheduledAt,
        nextAttemptAt: event.payload.nextAttemptAt
      };
    },
    intentDeadLettered: (state, event: Event<SagaRuntimeIntentDeadLetteredEventPayload>) => {
      const previous = state.intents[event.payload.intentKey];
      if (!previous) {
        return;
      }

      state.intents[event.payload.intentKey] = {
        ...previous,
        status: 'dead_lettered',
        attempts: event.payload.attempt,
        deadLetteredAt: event.payload.deadLetteredAt,
        deadLetterReason: event.payload.reason,
        lastErrorMessage: event.payload.errorMessage,
        completedAt: null,
        nextAttemptAt: null,
        scheduledRetryAt: null
      };
      if (state.activeIntentKey === event.payload.intentKey) {
        state.activeIntentKey = null;
      }
      state.deadLetteredIntentKeys = pushUnique(state.deadLetteredIntentKeys, event.payload.intentKey);
    }
  })
  .commands((emit) => ({
    observeEvent: (state, payload: SagaRuntimeObserveEventPayload) => {
      const sagaInstanceKey = deriveSagaRuntimeInstanceKey(payload.sagaType, payload.correlationId);

      if (state.lifecycle === 'active' && state.sagaInstanceKey && state.sagaInstanceKey !== sagaInstanceKey) {
        throw new Error(
          `Saga runtime correlation mismatch: expected '${state.sagaInstanceKey}' but observed '${sagaInstanceKey}'.`
        );
      }

      const events: Event[] = [
        emit.eventObserved({
          sagaType: payload.sagaType,
          correlationId: payload.correlationId,
          causationId: payload.causationId,
          sagaInstanceKey,
          isStart: payload.isStart,
          observedAt: payload.observedAt
        })
      ];

      if (shouldActivateSagaFromObservation(state, payload)) {
        events.push(emit.started({
          sagaType: payload.sagaType,
          correlationId: payload.correlationId,
          causationId: payload.causationId,
          sagaInstanceKey,
          startedAt: payload.observedAt
        }));
      }

      return events;
    },
    queueIntent: (state, payload: SagaRuntimeQueueIntentPayload) => {
      if (state.intents[payload.intentKey]) {
        throw new Error(`Intent '${payload.intentKey}' is already queued.`);
      }

      return emit.intentQueued(payload);
    },
    startIntent: (state, payload: SagaRuntimeStartIntentPayload) => {
      const intent = requireIntent(state, payload.intentKey);
      assertIntentNotTerminal(intent);

      if (intent.status !== 'queued' && intent.status !== 'retry_scheduled') {
        throw new Error(`Intent '${payload.intentKey}' cannot be started from status '${intent.status}'.`);
      }

      if (state.activeIntentKey && state.activeIntentKey !== payload.intentKey) {
        throw new Error(`Intent '${state.activeIntentKey}' is already in progress.`);
      }

      return emit.intentStarted(payload);
    },
    completeIntent: (state, payload: SagaRuntimeCompleteIntentPayload) => {
      const intent = requireIntent(state, payload.intentKey);
      assertIntentNotTerminal(intent);

      if (intent.status !== 'in_progress') {
        throw new Error(`Intent '${payload.intentKey}' cannot complete from status '${intent.status}'.`);
      }

      return emit.intentCompleted(payload);
    },
    failIntent: (state, payload: SagaRuntimeFailIntentPayload) => {
      const intent = requireIntent(state, payload.intentKey);
      assertIntentNotTerminal(intent);

      if (intent.status !== 'in_progress') {
        throw new Error(`Intent '${payload.intentKey}' cannot fail from status '${intent.status}'.`);
      }

      return emit.intentFailed(payload);
    },
    scheduleRetry: (state, payload: SagaRuntimeScheduleRetryPayload) => {
      const intent = requireIntent(state, payload.intentKey);
      assertIntentNotTerminal(intent);

      if (intent.status !== 'failed') {
        throw new Error(`Intent '${payload.intentKey}' cannot schedule retry from status '${intent.status}'.`);
      }

      if (!Number.isInteger(payload.attempt) || payload.attempt < 1) {
        throw new Error(`Intent '${payload.intentKey}' retry attempt must be >= 1.`);
      }

      return emit.intentRetryScheduled(payload);
    },
    deadLetterIntent: (state, payload: SagaRuntimeDeadLetterIntentPayload) => {
      const intent = requireIntent(state, payload.intentKey);
      assertIntentNotTerminal(intent);

      if (intent.status !== 'failed') {
        throw new Error(`Intent '${payload.intentKey}' cannot dead-letter from status '${intent.status}'.`);
      }

      if (!Number.isInteger(payload.attempt) || payload.attempt < 1) {
        throw new Error(`Intent '${payload.intentKey}' dead-letter attempt must be >= 1.`);
      }

      return emit.intentDeadLettered(payload);
    }
  }))
  .build();
