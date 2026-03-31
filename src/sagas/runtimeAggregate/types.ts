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

export const INITIAL_SAGA_RUNTIME_STATE: SagaRuntimeState = {
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
