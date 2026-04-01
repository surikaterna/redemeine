import { createAggregate } from '../../../createAggregate';
import { formatFlatEventType } from '../../../utils/naming';
import {
  deriveSagaRuntimeInstanceKey,
  shouldActivateSagaFromObservation
} from './aggregate/shared';
import { sagaRuntimeExecutionTransitionsMixin } from './aggregate/executionTransitionsMixin';
import { sagaRuntimeObservationStartMixin } from './aggregate/observationStartMixin';
import { sagaRuntimeQueueingMixin } from './aggregate/queueingMixin';
import { sagaRuntimeRetryDeadLetterMixin } from './aggregate/retryDeadLetterMixin';
import { INITIAL_SAGA_RUNTIME_STATE } from './aggregate/types';

export type {
  SagaRuntimeCompleteIntentPayload,
  SagaRuntimeDeadLetterIntentPayload,
  SagaRuntimeFailIntentPayload,
  SagaRuntimeIntentCompletedEventPayload,
  SagaRuntimeIntentDeadLetteredEventPayload,
  SagaRuntimeIntentFailedEventPayload,
  SagaRuntimeIntentQueuedEventPayload,
  SagaRuntimeIntentRetryScheduledEventPayload,
  SagaRuntimeIntentStartedEventPayload,
  SagaRuntimeIntentState,
  SagaRuntimeObserveEventPayload,
  SagaRuntimeObservedEventPayload,
  SagaRuntimeQueueIntentPayload,
  SagaRuntimeScheduleRetryPayload,
  SagaRuntimeStartIntentPayload,
  SagaRuntimeStartedEventPayload,
  SagaRuntimeState
} from './aggregate/types';

export {
  deriveSagaRuntimeInstanceKey,
  shouldActivateSagaFromObservation
};

/**
 * Hidden/internal runtime aggregate contract for saga execution bookkeeping.
 */
export const SagaRuntimeAggregate = createAggregate('sagaRuntime', INITIAL_SAGA_RUNTIME_STATE)
  .naming({
    event: formatFlatEventType
  })
  .mixins(
    sagaRuntimeObservationStartMixin,
    sagaRuntimeQueueingMixin,
    sagaRuntimeExecutionTransitionsMixin,
    sagaRuntimeRetryDeadLetterMixin
  )
  .build();

export type SagaRuntimeCommandName = keyof typeof SagaRuntimeAggregate.commandCreators;
export type SagaRuntimeEventName = keyof typeof SagaRuntimeAggregate.pure.eventProjectors;
