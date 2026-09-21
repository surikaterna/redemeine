import type { Event } from '@redemeine/kernel';
import type {
  SagaActivityLifecycleRecordedEventPayload,
  SagaAggregateState,
  SagaBusinessStateRecordedEventPayload,
  SagaInstanceCreatedEventPayload,
  SagaIntentLifecycleRecordedEventPayload,
  SagaRecentWindowLimits,
  SagaSourceEventObservedEventPayload,
  SagaStateTransitionedEventPayload
} from './sagaAggregateContracts';

function appendRecentWindow<T>(window: T[], value: T, limit: number): T[] {
  if (limit === 0) return [];
  return [value, ...window].slice(0, limit);
}

export function createSagaAggregateProjectors<TState>(windowLimits: SagaRecentWindowLimits) {
  return {
    instanceCreated: (state: SagaAggregateState<TState>, event: Event<SagaInstanceCreatedEventPayload>) => {
      Object.assign(state, {
        id: event.payload.id,
        sagaType: event.payload.sagaType,
        lifecycleState: event.payload.lifecycleState,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.createdAt,
        transitionVersion: state.transitionVersion + 1
      });
    },
    sourceEventObserved: (state: SagaAggregateState<TState>, event: Event<SagaSourceEventObservedEventPayload>) => {
      state.updatedAt = event.payload.record.observedAt;
      state.transitionVersion += 1;
      state.totals.observedEvents += 1;
      state.recent.events = appendRecentWindow(state.recent.events, event.payload.record, windowLimits.events);
    },
    stateTransitioned: (state: SagaAggregateState<TState>, event: Event<SagaStateTransitionedEventPayload>) => {
      state.lifecycleState = event.payload.record.toState as SagaAggregateState['lifecycleState'];
      state.updatedAt = event.payload.record.transitionAt;
      state.transitionVersion += 1;
      state.totals.transitions += 1;
      state.recent.transitions = appendRecentWindow(state.recent.transitions, event.payload.record, windowLimits.transitions);
    },
    intentLifecycleRecorded: (state: SagaAggregateState<TState>, event: Event<SagaIntentLifecycleRecordedEventPayload>) => {
      state.updatedAt = event.payload.record.recordedAt;
      state.transitionVersion += 1;
      state.totals.intents += 1;
      state.recent.intents = appendRecentWindow(state.recent.intents, event.payload.record, windowLimits.intents);
    },
    activityLifecycleRecorded: (state: SagaAggregateState<TState>, event: Event<SagaActivityLifecycleRecordedEventPayload>) => {
      state.updatedAt = event.payload.record.recordedAt;
      state.transitionVersion += 1;
      state.totals.activities += 1;
      state.recent.activities = appendRecentWindow(state.recent.activities, event.payload.record, windowLimits.activities);
    },
    businessStateRecorded: (state: SagaAggregateState<TState>, event: Event<SagaBusinessStateRecordedEventPayload<TState>>) => {
      state.sagaKey = event.payload.sagaKey;
      state.definitionVersion = event.payload.definitionVersion;
      state.correlation = event.payload.correlation;
      state.businessState = event.payload.state;
      state.updatedAt = event.payload.recordedAt;
      state.transitionVersion += 1;
    }
  };
}
