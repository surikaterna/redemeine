import { createMixin } from '../../createMixin';
import type { Event } from '../../types';
import {
  assertIntentNotTerminal,
  pushUnique,
  requireIntent
} from './shared';
import type {
  SagaRuntimeCompleteIntentPayload,
  SagaRuntimeFailIntentPayload,
  SagaRuntimeIntentCompletedEventPayload,
  SagaRuntimeIntentFailedEventPayload,
  SagaRuntimeIntentStartedEventPayload,
  SagaRuntimeIntentState,
  SagaRuntimeStartIntentPayload,
  SagaRuntimeState
} from './types';

export const sagaRuntimeExecutionTransitionsMixin = createMixin<SagaRuntimeState>()
  .events({
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
    }
  })
  .commands((emit) => ({
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
    }
  }))
  .build();
