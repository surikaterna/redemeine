import { createMixin } from '../../../../createMixin';
import type { Event } from '../../../../types';
import {
  assertIntentNotTerminal,
  pushUnique,
  requireIntent
} from './shared';
import type {
  SagaRuntimeDeadLetterIntentPayload,
  SagaRuntimeIntentDeadLetteredEventPayload,
  SagaRuntimeIntentRetryScheduledEventPayload,
  SagaRuntimeScheduleRetryPayload,
  SagaRuntimeState
} from './types';

export const sagaRuntimeRetryDeadLetterMixin = createMixin<SagaRuntimeState>()
  .events({
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
