import type { EventEmitterFactory } from '@redemeine/aggregate';
import type { ReadonlyDeep } from '@redemeine/kernel';
import { type BusinessStateValidationOptions, validateBusinessState } from './businessStateValidation';
import type {
  SagaAggregateState,
  SagaBusinessStateRecordedEventPayload,
  SagaCanonicalCorrelation,
  SagaCreateInstanceCommandPayload,
  SagaObserveSourceEventCommandPayload,
  SagaRecordActivityLifecycleCommandPayload,
  SagaRecordIntentLifecycleCommandPayload,
  SagaRecordStateTransitionCommandPayload
} from './sagaAggregateContracts';
import { SagaTransitionInvariantError } from './sagaAggregateContracts';
import type { createSagaAggregateProjectors } from './sagaAggregateProjectors';

type SagaCommandState<TState> = ReadonlyDeep<SagaAggregateState<TState>>;
type SagaEventEmitter<TState> = EventEmitterFactory<string, ReturnType<typeof createSagaAggregateProjectors<TState>>, Record<string, string>>;

function toIso8601(value?: string): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function toRequiredIso8601(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('recordBusinessState recordedAt must be a valid timestamp');
  return parsed.toISOString();
}

function requireCreatedInstance(state: SagaCommandState<unknown>, command: string): void {
  if (state.id) return;
  throw new SagaTransitionInvariantError('saga_instance_not_created', `${command} rejected: saga instance must be created first`, {
    command,
    sagaId: state.id,
    currentState: state.lifecycleState,
    transitionVersion: state.transitionVersion
  });
}

function assertCorrelation(correlation: SagaCanonicalCorrelation): void {
  const validString = correlation.type === 'string' && correlation.value.length > 0;
  const validNumber = correlation.type === 'number' && Number.isSafeInteger(correlation.value) && !Object.is(correlation.value, -0);
  if (!validString && !validNumber) throw new TypeError('recordBusinessState correlation must be canonical');
}

function assertBusinessStateIdentity(payload: SagaBusinessStateRecordedEventPayload): void {
  if (payload.sagaKey.length === 0) throw new TypeError('recordBusinessState sagaKey must not be empty');
  if (!Number.isSafeInteger(payload.definitionVersion) || payload.definitionVersion <= 0) {
    throw new TypeError('recordBusinessState definitionVersion must be a positive safe integer');
  }
  if (payload.sourceTriggerId.length === 0) throw new TypeError('recordBusinessState sourceTriggerId must not be empty');
  assertCorrelation(payload.correlation);
}

function transitionDetails(state: SagaCommandState<unknown>, payload: SagaRecordStateTransitionCommandPayload) {
  return {
    command: 'recordStateTransition',
    sagaId: state.id,
    fromState: payload.fromState,
    toState: payload.toState,
    currentState: state.lifecycleState,
    transitionVersion: state.transitionVersion
  };
}

function assertStateTransition(state: SagaCommandState<unknown>, payload: SagaRecordStateTransitionCommandPayload): void {
  const details = transitionDetails(state, payload);
  if (state.lifecycleState === 'completed' || state.lifecycleState === 'failed' || state.lifecycleState === 'cancelled') {
    throw new SagaTransitionInvariantError(
      'saga_transition_from_terminal_state',
      'recordStateTransition rejected: terminal saga state cannot transition',
      details
    );
  }
  if (payload.fromState !== state.lifecycleState) {
    throw new SagaTransitionInvariantError(
      'saga_transition_from_state_mismatch',
      'recordStateTransition rejected: fromState does not match current lifecycle state',
      details
    );
  }
  if (payload.fromState === payload.toState) {
    throw new SagaTransitionInvariantError('saga_transition_noop', 'recordStateTransition rejected: fromState and toState must differ', details);
  }
}

export function createSagaAggregateCommands<TState>(emit: SagaEventEmitter<TState>, validationOptions?: BusinessStateValidationOptions) {
  return {
    createInstance: (state: SagaCommandState<TState>, payload: SagaCreateInstanceCommandPayload) => {
      if (state.id) {
        throw new SagaTransitionInvariantError('saga_instance_already_created', 'createInstance rejected: saga instance already exists', {
          command: 'createInstance',
          sagaId: state.id,
          currentState: state.lifecycleState,
          transitionVersion: state.transitionVersion
        });
      }
      return emit.instanceCreated({
        ...payload,
        lifecycleState: payload.lifecycleState ?? 'active',
        createdAt: toIso8601(payload.createdAt)
      });
    },
    observeSourceEvent: (state: SagaCommandState<TState>, payload: SagaObserveSourceEventCommandPayload) => {
      requireCreatedInstance(state, 'observeSourceEvent');
      return emit.sourceEventObserved({ record: { ...payload, observedAt: toIso8601(payload.observedAt) } });
    },
    recordStateTransition: (state: SagaCommandState<TState>, payload: SagaRecordStateTransitionCommandPayload) => {
      requireCreatedInstance(state, 'recordStateTransition');
      assertStateTransition(state, payload);
      return emit.stateTransitioned({ record: { ...payload, transitionAt: toIso8601(payload.transitionAt) } });
    },
    recordIntentLifecycle: (state: SagaCommandState<TState>, payload: SagaRecordIntentLifecycleCommandPayload) => {
      requireCreatedInstance(state, 'recordIntentLifecycle');
      return emit.intentLifecycleRecorded({ record: { ...payload, recordedAt: toIso8601(payload.recordedAt) } });
    },
    recordActivityLifecycle: (state: SagaCommandState<TState>, payload: SagaRecordActivityLifecycleCommandPayload) => {
      requireCreatedInstance(state, 'recordActivityLifecycle');
      return emit.activityLifecycleRecorded({ record: { ...payload, recordedAt: toIso8601(payload.recordedAt) } });
    },
    recordBusinessState: (state: SagaCommandState<TState>, payload: SagaBusinessStateRecordedEventPayload<TState>) => {
      requireCreatedInstance(state, 'recordBusinessState');
      assertBusinessStateIdentity(payload);
      validateBusinessState(payload.state, validationOptions);
      return emit.businessStateRecorded({ ...payload, recordedAt: toRequiredIso8601(payload.recordedAt) });
    }
  };
}
