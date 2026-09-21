import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { type BusinessStateValidationOptions, validateBusinessState } from './businessStateValidation';
import {
  type SagaActivityLifecycleRecordedEventPayload,
  type SagaAggregateState,
  type SagaBusinessStateRecordedEventPayload,
  type SagaCanonicalCorrelation,
  type SagaInstanceCreatedEventPayload,
  type SagaIntentLifecycleRecordedEventPayload,
  type SagaRecentWindowLimits,
  type SagaSourceEventObservedEventPayload,
  type SagaStateTransitionedEventPayload,
  SagaTransitionInvariantError
} from './sagaAggregateContracts';

export interface CreateSagaAggregateOptions<TState = unknown> {
  aggregateName?: string;
  initialState?: Partial<SagaAggregateState<TState>>;
  recentWindowLimits?: Partial<SagaRecentWindowLimits>;
  businessStateValidation?: BusinessStateValidationOptions;
}

const defaultRecentWindowLimits: SagaRecentWindowLimits = {
  transitions: 50,
  events: 50,
  intents: 50,
  activities: 50
};

function createInitialState<TState>(): SagaAggregateState<TState> {
  return {
    id: null,
    sagaType: null,
    sagaKey: null,
    definitionVersion: null,
    correlation: null,
    businessState: null,
    lifecycleState: 'idle',
    createdAt: null,
    updatedAt: null,
    transitionVersion: 0,
    totals: { transitions: 0, observedEvents: 0, intents: 0, activities: 0 },
    recent: { transitions: [], events: [], intents: [], activities: [] }
  };
}

function normalizeWindowLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 0) return 0;
  return Math.floor(limit);
}

function appendRecentWindow<T>(window: T[], value: T, limit: number): T[] {
  const max = normalizeWindowLimit(limit);
  if (max === 0) return [];
  return [value, ...window].slice(0, max);
}

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

const toSnakeCase = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const isTerminalLifecycleState = (state: string): boolean => state === 'completed' || state === 'failed' || state === 'cancelled';

type SagaInvariantStateView = Readonly<Pick<SagaAggregateState, 'id' | 'lifecycleState' | 'transitionVersion'>>;

function requireCreatedInstance(state: SagaInvariantStateView, command: string): void {
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

function createWindowLimits(options: CreateSagaAggregateOptions): SagaRecentWindowLimits {
  return {
    transitions: normalizeWindowLimit(options.recentWindowLimits?.transitions ?? defaultRecentWindowLimits.transitions),
    events: normalizeWindowLimit(options.recentWindowLimits?.events ?? defaultRecentWindowLimits.events),
    intents: normalizeWindowLimit(options.recentWindowLimits?.intents ?? defaultRecentWindowLimits.intents),
    activities: normalizeWindowLimit(options.recentWindowLimits?.activities ?? defaultRecentWindowLimits.activities)
  };
}

function mergeInitialState<TState>(partial?: Partial<SagaAggregateState<TState>>): SagaAggregateState<TState> {
  const defaults = createInitialState<TState>();
  return {
    ...defaults,
    ...partial,
    totals: { ...defaults.totals, ...partial?.totals },
    recent: { ...defaults.recent, ...partial?.recent }
  };
}

export function createSagaAggregate<TAggregateName extends string = 'saga', TState = unknown>(
  options: CreateSagaAggregateOptions<TState> & { aggregateName?: TAggregateName } = {}
) {
  const aggregateName = (options.aggregateName ?? 'saga') as TAggregateName;
  const windowLimits = createWindowLimits(options);
  const initialState = mergeInitialState(options.initialState);

  const built = createAggregate(aggregateName, initialState)
    .events({
      instanceCreated: (state, event: Event<SagaInstanceCreatedEventPayload>) => {
        Object.assign(state, {
          id: event.payload.id,
          sagaType: event.payload.sagaType,
          lifecycleState: event.payload.lifecycleState,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.createdAt,
          transitionVersion: state.transitionVersion + 1
        });
      },
      sourceEventObserved: (state, event: Event<SagaSourceEventObservedEventPayload>) => {
        state.updatedAt = event.payload.record.observedAt;
        state.transitionVersion += 1;
        state.totals.observedEvents += 1;
        state.recent.events = appendRecentWindow(state.recent.events, event.payload.record, windowLimits.events);
      },
      stateTransitioned: (state, event: Event<SagaStateTransitionedEventPayload>) => {
        state.lifecycleState = event.payload.record.toState as SagaAggregateState['lifecycleState'];
        state.updatedAt = event.payload.record.transitionAt;
        state.transitionVersion += 1;
        state.totals.transitions += 1;
        state.recent.transitions = appendRecentWindow(state.recent.transitions, event.payload.record, windowLimits.transitions);
      },
      intentLifecycleRecorded: (state, event: Event<SagaIntentLifecycleRecordedEventPayload>) => {
        state.updatedAt = event.payload.record.recordedAt;
        state.transitionVersion += 1;
        state.totals.intents += 1;
        state.recent.intents = appendRecentWindow(state.recent.intents, event.payload.record, windowLimits.intents);
      },
      activityLifecycleRecorded: (state, event: Event<SagaActivityLifecycleRecordedEventPayload>) => {
        state.updatedAt = event.payload.record.recordedAt;
        state.transitionVersion += 1;
        state.totals.activities += 1;
        state.recent.activities = appendRecentWindow(state.recent.activities, event.payload.record, windowLimits.activities);
      },
      businessStateRecorded: (state, event: Event<SagaBusinessStateRecordedEventPayload<TState>>) => {
        state.sagaKey = event.payload.sagaKey;
        state.definitionVersion = event.payload.definitionVersion;
        state.correlation = event.payload.correlation;
        state.businessState = event.payload.state;
        state.updatedAt = event.payload.recordedAt;
        state.transitionVersion += 1;
      }
    })
    .commands((emit) => ({
      createInstance: (state, payload) => {
        if (state.id) {
          throw new SagaTransitionInvariantError('saga_instance_already_created', 'createInstance rejected: saga instance already exists', {
            command: 'createInstance',
            sagaId: state.id,
            currentState: state.lifecycleState,
            transitionVersion: state.transitionVersion
          });
        }
        return emit.instanceCreated({
          id: payload.id,
          sagaType: payload.sagaType,
          lifecycleState: payload.lifecycleState ?? 'active',
          createdAt: toIso8601(payload.createdAt),
          ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {})
        });
      },
      observeSourceEvent: (state, payload) => {
        requireCreatedInstance(state, 'observeSourceEvent');
        return emit.sourceEventObserved({ record: { ...payload, observedAt: toIso8601(payload.observedAt) } });
      },
      recordStateTransition: (state, payload) => {
        requireCreatedInstance(state, 'recordStateTransition');
        if (isTerminalLifecycleState(state.lifecycleState)) {
          throw new SagaTransitionInvariantError(
            'saga_transition_from_terminal_state',
            'recordStateTransition rejected: terminal saga state cannot transition',
            {
              command: 'recordStateTransition',
              sagaId: state.id,
              fromState: payload.fromState,
              toState: payload.toState,
              currentState: state.lifecycleState,
              transitionVersion: state.transitionVersion
            }
          );
        }
        if (payload.fromState !== state.lifecycleState) {
          throw new SagaTransitionInvariantError(
            'saga_transition_from_state_mismatch',
            'recordStateTransition rejected: fromState does not match current lifecycle state',
            {
              command: 'recordStateTransition',
              sagaId: state.id,
              fromState: payload.fromState,
              toState: payload.toState,
              currentState: state.lifecycleState,
              transitionVersion: state.transitionVersion
            }
          );
        }
        if (payload.fromState === payload.toState) {
          throw new SagaTransitionInvariantError('saga_transition_noop', 'recordStateTransition rejected: fromState and toState must differ', {
            command: 'recordStateTransition',
            sagaId: state.id,
            fromState: payload.fromState,
            toState: payload.toState,
            currentState: state.lifecycleState,
            transitionVersion: state.transitionVersion
          });
        }
        return emit.stateTransitioned({ record: { ...payload, transitionAt: toIso8601(payload.transitionAt) } });
      },
      recordIntentLifecycle: (state, payload) => {
        requireCreatedInstance(state, 'recordIntentLifecycle');
        return emit.intentLifecycleRecorded({ record: { ...payload, recordedAt: toIso8601(payload.recordedAt) } });
      },
      recordActivityLifecycle: (state, payload) => {
        requireCreatedInstance(state, 'recordActivityLifecycle');
        return emit.activityLifecycleRecorded({ record: { ...payload, recordedAt: toIso8601(payload.recordedAt) } });
      },
      recordBusinessState: (state, payload) => {
        requireCreatedInstance(state, 'recordBusinessState');
        assertBusinessStateIdentity(payload);
        validateBusinessState(payload.state, options.businessStateValidation);
        return emit.businessStateRecorded({ ...payload, recordedAt: toRequiredIso8601(payload.recordedAt) });
      }
    }))
    .overrideEventNames({
      instanceCreated: `${aggregateName}.${toSnakeCase('instanceCreated')}.event`,
      sourceEventObserved: `${aggregateName}.${toSnakeCase('sourceEventObserved')}.event`,
      stateTransitioned: `${aggregateName}.${toSnakeCase('stateTransitioned')}.event`,
      intentLifecycleRecorded: `${aggregateName}.${toSnakeCase('intentLifecycleRecorded')}.event`,
      activityLifecycleRecorded: `${aggregateName}.${toSnakeCase('activityLifecycleRecorded')}.event`,
      businessStateRecorded: 'saga.business_state_recorded.event'
    })
    .build();

  return { ...built, aggregateType: aggregateName, windowLimits };
}

export type SagaAggregate<TState = unknown> = ReturnType<typeof createSagaAggregate<string, TState>>;
