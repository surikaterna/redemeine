import { createMixin } from '../../createMixin';
import type { Event } from '../../types';
import {
  deriveSagaRuntimeInstanceKey,
  shouldActivateSagaFromObservation
} from './shared';
import type {
  SagaRuntimeObserveEventPayload,
  SagaRuntimeObservedEventPayload,
  SagaRuntimeStartedEventPayload,
  SagaRuntimeState
} from './types';

export const sagaRuntimeObservationStartMixin = createMixin<SagaRuntimeState>()
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
    }
  }))
  .build();
