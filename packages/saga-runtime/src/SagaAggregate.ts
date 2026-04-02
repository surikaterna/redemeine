import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

export interface SagaRecentWindowLimits {
  transitions: number;
  events: number;
  intents: number;
  activities: number;
}

export interface SagaObservedSourceEventRecord {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  eventId?: string;
  sequence?: number;
  correlationId?: string;
  causationId?: string;
  observedAt: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SagaStateTransitionRecord {
  fromState: string;
  toState: string;
  reason?: string;
  transitionAt: string;
  metadata?: Record<string, unknown>;
}

export interface SagaIntentLifecycleRecord {
  intentId: string;
  intentType: string;
  stage: 'created' | 'scheduled' | 'dispatched' | 'acknowledged' | 'failed' | 'cancelled';
  recordedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaActivityLifecycleRecord {
  activityId: string;
  activityName: string;
  stage: 'started' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled';
  attempt?: number;
  recordedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaAggregateState {
  sagaId: string | null;
  sagaType: string | null;
  lifecycleState: 'idle' | 'active' | 'completed' | 'failed' | 'cancelled';
  createdAt: string | null;
  updatedAt: string | null;
  transitionVersion: number;
  totals: {
    transitions: number;
    observedEvents: number;
    intents: number;
    activities: number;
  };
  recent: {
    transitions: SagaStateTransitionRecord[];
    events: SagaObservedSourceEventRecord[];
    intents: SagaIntentLifecycleRecord[];
    activities: SagaActivityLifecycleRecord[];
  };
}

export interface SagaCreateInstanceCommandPayload {
  sagaId: string;
  sagaType: string;
  lifecycleState?: SagaAggregateState['lifecycleState'];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaObserveSourceEventCommandPayload {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  eventId?: string;
  sequence?: number;
  correlationId?: string;
  causationId?: string;
  observedAt?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordStateTransitionCommandPayload {
  fromState: string;
  toState: string;
  reason?: string;
  transitionAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordIntentLifecycleCommandPayload {
  intentId: string;
  intentType: string;
  stage: SagaIntentLifecycleRecord['stage'];
  recordedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordActivityLifecycleCommandPayload {
  activityId: string;
  activityName: string;
  stage: SagaActivityLifecycleRecord['stage'];
  attempt?: number;
  recordedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaInstanceCreatedEventPayload {
  sagaId: string;
  sagaType: string;
  lifecycleState: SagaAggregateState['lifecycleState'];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SagaSourceEventObservedEventPayload {
  record: SagaObservedSourceEventRecord;
}

export interface SagaStateTransitionedEventPayload {
  record: SagaStateTransitionRecord;
}

export interface SagaIntentLifecycleRecordedEventPayload {
  record: SagaIntentLifecycleRecord;
}

export interface SagaActivityLifecycleRecordedEventPayload {
  record: SagaActivityLifecycleRecord;
}

export interface CreateSagaAggregateOptions {
  aggregateName?: string;
  initialState?: Partial<SagaAggregateState>;
  recentWindowLimits?: Partial<SagaRecentWindowLimits>;
}

const defaultRecentWindowLimits: SagaRecentWindowLimits = {
  transitions: 50,
  events: 50,
  intents: 50,
  activities: 50
};

const createInitialState = (): SagaAggregateState => ({
  sagaId: null,
  sagaType: null,
  lifecycleState: 'idle',
  createdAt: null,
  updatedAt: null,
  transitionVersion: 0,
  totals: {
    transitions: 0,
    observedEvents: 0,
    intents: 0,
    activities: 0
  },
  recent: {
    transitions: [],
    events: [],
    intents: [],
    activities: []
  }
});

const normalizeWindowLimit = (limit: number): number => {
  if (!Number.isFinite(limit) || limit < 0) {
    return 0;
  }

  return Math.floor(limit);
};

const appendRecentWindow = <T>(window: T[], value: T, limit: number): T[] => {
  const max = normalizeWindowLimit(limit);
  if (max === 0) {
    return [];
  }

  return [value, ...window].slice(0, max);
};

const toIso8601 = (value?: string): string => {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
};

const toSnakeCase = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function createSagaAggregate<TAggregateName extends string = 'saga'>(
  options: CreateSagaAggregateOptions & { aggregateName?: TAggregateName } = {}
) {
  const aggregateName = (options.aggregateName ?? 'saga') as TAggregateName;
  const windowLimits: SagaRecentWindowLimits = {
    transitions: normalizeWindowLimit(options.recentWindowLimits?.transitions ?? defaultRecentWindowLimits.transitions),
    events: normalizeWindowLimit(options.recentWindowLimits?.events ?? defaultRecentWindowLimits.events),
    intents: normalizeWindowLimit(options.recentWindowLimits?.intents ?? defaultRecentWindowLimits.intents),
    activities: normalizeWindowLimit(options.recentWindowLimits?.activities ?? defaultRecentWindowLimits.activities)
  };

  const initialState: SagaAggregateState = {
    ...createInitialState(),
    ...options.initialState,
    totals: {
      ...createInitialState().totals,
      ...options.initialState?.totals
    },
    recent: {
      ...createInitialState().recent,
      ...options.initialState?.recent
    }
  };

  const built = createAggregate(aggregateName, initialState)
    .events({
      instanceCreated: (state, event: Event<SagaInstanceCreatedEventPayload>) => {
        state.sagaId = event.payload.sagaId;
        state.sagaType = event.payload.sagaType;
        state.lifecycleState = event.payload.lifecycleState;
        state.createdAt = event.payload.createdAt;
        state.updatedAt = event.payload.createdAt;
        state.transitionVersion += 1;
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
      }
    })
    .commands((emit) => ({
      createInstance: (_state, payload: SagaCreateInstanceCommandPayload) => emit.instanceCreated({
        sagaId: payload.sagaId,
        sagaType: payload.sagaType,
        lifecycleState: payload.lifecycleState ?? 'active',
        createdAt: toIso8601(payload.createdAt),
        metadata: payload.metadata
      }),
      observeSourceEvent: (_state, payload: SagaObserveSourceEventCommandPayload) => emit.sourceEventObserved({
        record: {
          ...payload,
          observedAt: toIso8601(payload.observedAt)
        }
      }),
      recordStateTransition: (_state, payload: SagaRecordStateTransitionCommandPayload) => emit.stateTransitioned({
        record: {
          ...payload,
          transitionAt: toIso8601(payload.transitionAt)
        }
      }),
      recordIntentLifecycle: (_state, payload: SagaRecordIntentLifecycleCommandPayload) => emit.intentLifecycleRecorded({
        record: {
          ...payload,
          recordedAt: toIso8601(payload.recordedAt)
        }
      }),
      recordActivityLifecycle: (_state, payload: SagaRecordActivityLifecycleCommandPayload) => emit.activityLifecycleRecorded({
        record: {
          ...payload,
          recordedAt: toIso8601(payload.recordedAt)
        }
      })
    }))
    .overrideEventNames({
      instanceCreated: `${aggregateName}.${toSnakeCase('instanceCreated')}.event`,
      sourceEventObserved: `${aggregateName}.${toSnakeCase('sourceEventObserved')}.event`,
      stateTransitioned: `${aggregateName}.${toSnakeCase('stateTransitioned')}.event`,
      intentLifecycleRecorded: `${aggregateName}.${toSnakeCase('intentLifecycleRecorded')}.event`,
      activityLifecycleRecorded: `${aggregateName}.${toSnakeCase('activityLifecycleRecorded')}.event`
    })
    .build();

  return {
    ...built,
    __aggregateType: aggregateName,
    windowLimits
  };
}

export type SagaAggregate = ReturnType<typeof createSagaAggregate>;
