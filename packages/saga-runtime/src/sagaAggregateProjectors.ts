import type { Event } from '@redemeine/kernel';
import type {
  NormalizedSagaAggregateState,
  SagaActivityLifecycleRecordedEventPayload,
  SagaBusinessStateRecordedEventPayload,
  SagaDefinitionIdentityRecordedEventPayload,
  SagaInstanceCreatedEventPayload,
  SagaIntentLifecycleRecordedEventPayload,
  SagaRecentWindowLimits,
  SagaSourceEventObservedEventPayload,
  SagaStateTransitionedEventPayload
} from './sagaAggregateContracts';
import { assertSagaLifecycleState } from './sagaAggregateContracts';

function appendRecentWindow<T>(window: T[], value: T, limit: number): T[] {
  if (limit === 0) return [];
  return [value, ...window].slice(0, limit);
}

export function createSagaAggregateProjectors<TState>(windowLimits: SagaRecentWindowLimits) {
  return {
    instanceCreated: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaInstanceCreatedEventPayload>) => {
      assertSagaLifecycleState(event.payload.lifecycleState);
      Object.assign(state, {
        id: event.payload.id,
        sagaType: event.payload.sagaType,
        lifecycleState: event.payload.lifecycleState,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.createdAt,
        transitionVersion: state.transitionVersion + 1
      });
    },
    definitionIdentityRecorded: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaDefinitionIdentityRecordedEventPayload>) => {
      state.definitionIdentity = {
        sagaKey: event.payload.sagaKey,
        definitionVersion: event.payload.definitionVersion,
        policySha256: event.payload.policySha256
      };
      state.transitionVersion += 1;
    },
    sourceEventObserved: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaSourceEventObservedEventPayload>) => {
      state.updatedAt = event.payload.record.observedAt;
      state.transitionVersion += 1;
      state.totals.observedEvents += 1;
      state.recent.events = appendRecentWindow(state.recent.events, event.payload.record, windowLimits.events);
    },
    stateTransitioned: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaStateTransitionedEventPayload>) => {
      assertSagaLifecycleState(event.payload.record.toState);
      state.lifecycleState = event.payload.record.toState;
      state.updatedAt = event.payload.record.transitionAt;
      state.transitionVersion += 1;
      state.totals.transitions += 1;
      state.recent.transitions = appendRecentWindow(state.recent.transitions, event.payload.record, windowLimits.transitions);
    },
    intentLifecycleRecorded: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaIntentLifecycleRecordedEventPayload>) => {
      state.updatedAt = event.payload.record.recordedAt;
      state.transitionVersion += 1;
      state.totals.intents += 1;
      state.recent.intents = appendRecentWindow(state.recent.intents, event.payload.record, windowLimits.intents);
    },
    activityLifecycleRecorded: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaActivityLifecycleRecordedEventPayload>) => {
      state.updatedAt = event.payload.record.recordedAt;
      state.transitionVersion += 1;
      state.totals.activities += 1;
      state.recent.activities = appendRecentWindow(state.recent.activities, event.payload.record, windowLimits.activities);
    },
    businessStateRecorded: (state: NormalizedSagaAggregateState<TState>, event: Event<SagaBusinessStateRecordedEventPayload<TState>>) => {
      state.sagaKey = event.payload.sagaKey;
      state.definitionVersion = event.payload.definitionVersion;
      state.correlation = event.payload.correlation;
      state.businessState = event.payload.state;
      state.updatedAt = event.payload.recordedAt;
      state.transitionVersion += 1;
    }
  };
}
