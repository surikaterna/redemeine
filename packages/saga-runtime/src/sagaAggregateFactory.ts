import { createAggregate } from '@redemeine/aggregate';
import type { BusinessStateValidationOptions } from './businessStateValidation';
import { createSagaAggregateCommands } from './sagaAggregateCommands';
import type { SagaAggregateState, SagaRecentWindowLimits } from './sagaAggregateContracts';
import { createSagaAggregateProjectors } from './sagaAggregateProjectors';

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

const toSnakeCase = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function createSagaAggregate<TAggregateName extends string = 'saga', TState = unknown>(
  options: CreateSagaAggregateOptions<TState> & { aggregateName?: TAggregateName } = {}
) {
  const aggregateName = (options.aggregateName ?? 'saga') as TAggregateName;
  const windowLimits = createWindowLimits(options);
  const projectors = createSagaAggregateProjectors<TState>(windowLimits);
  const built = createAggregate(aggregateName, mergeInitialState(options.initialState))
    .events(projectors)
    .commands((emit) => createSagaAggregateCommands(emit, options.businessStateValidation))
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
