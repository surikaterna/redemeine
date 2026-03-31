import { createMixin } from '../../createMixin';
import type { Event } from '../../types';
import type {
  SagaRuntimeIntentQueuedEventPayload,
  SagaRuntimeQueueIntentPayload,
  SagaRuntimeState
} from './types';

export const sagaRuntimeQueueingMixin = createMixin<SagaRuntimeState>()
  .events({
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
    }
  })
  .commands((emit) => ({
    queueIntent: (state, payload: SagaRuntimeQueueIntentPayload) => {
      if (state.intents[payload.intentKey]) {
        throw new Error(`Intent '${payload.intentKey}' is already queued.`);
      }

      return emit.intentQueued(payload);
    }
  }))
  .build();
