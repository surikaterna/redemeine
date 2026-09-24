import { createAggregate } from '@redemeine/aggregate';
import type { BusinessStateValidationOptions } from './businessStateValidation';
import { createSagaAggregateCommands } from './sagaAggregateCommands';
import { assertSagaLifecycleState, type NormalizedSagaAggregateState, type SagaAggregateState, type SagaRecentWindowLimits } from './sagaAggregateContracts';
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

function createInitialState<TState>(): NormalizedSagaAggregateState<TState> {
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

export function normalizeSagaAggregateState<TState>(partial?: Partial<SagaAggregateState<TState>>): NormalizedSagaAggregateState<TState> {
  const defaults = createInitialState<TState>();
  const lifecycleState: unknown = partial?.lifecycleState ?? defaults.lifecycleState;
  assertSagaLifecycleState(lifecycleState);
  return {
    ...defaults,
    ...partial,
    sagaKey: partial?.sagaKey ?? null,
    definitionVersion: partial?.definitionVersion ?? null,
    correlation: partial?.correlation ?? null,
    businessState: partial?.businessState ?? null,
    lifecycleState,
    totals: { ...defaults.totals, ...partial?.totals },
    recent: { ...defaults.recent, ...partial?.recent }
  };
}

function hydrateSagaAggregateState<TState>(state: SagaAggregateState<TState>): asserts state is NormalizedSagaAggregateState<TState> {
  state.sagaKey ??= null;
  state.definitionVersion ??= null;
  state.correlation ??= null;
  state.businessState ??= null;
}

const toSnakeCase = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function buildSagaAggregate<TAggregateName extends string, TState>(aggregateName: TAggregateName, options: CreateSagaAggregateOptions<TState>) {
  const windowLimits = createWindowLimits(options);
  const projectors = createSagaAggregateProjectors<TState>(windowLimits);
  const built = createAggregate(aggregateName, normalizeSagaAggregateState(options.initialState))
    .events(projectors)
    .commands((emit) => createSagaAggregateCommands<TState>(emit, options.businessStateValidation))
    .overrideEventNames({
      instanceCreated: `${aggregateName}.${toSnakeCase('instanceCreated')}.event`,
      sourceEventObserved: `${aggregateName}.${toSnakeCase('sourceEventObserved')}.event`,
      stateTransitioned: `${aggregateName}.${toSnakeCase('stateTransitioned')}.event`,
      intentLifecycleRecorded: `${aggregateName}.${toSnakeCase('intentLifecycleRecorded')}.event`,
      activityLifecycleRecorded: `${aggregateName}.${toSnakeCase('activityLifecycleRecorded')}.event`,
      businessStateRecorded: 'saga.business_state_recorded.event'
    })
    .build();
  return {
    ...built,
    aggregateType: aggregateName,
    windowLimits,
    process: (state: SagaAggregateState<TState>, command: Parameters<typeof built.process>[1]) => built.process(normalizeSagaAggregateState(state), command),
    apply: (state: SagaAggregateState<TState>, event: Parameters<typeof built.apply>[1]) => built.apply(normalizeSagaAggregateState(state), event),
    applyToDraft: (state: SagaAggregateState<TState>, event: Parameters<typeof built.applyToDraft>[1]) => {
      hydrateSagaAggregateState(state);
      built.applyToDraft(state, event);
    }
  };
}

type BuiltSagaAggregate<TAggregateName extends string, TState> = ReturnType<typeof buildSagaAggregate<TAggregateName, TState>>;

export function createSagaAggregate<TAggregateName extends 'saga' = 'saga', TState = unknown>(
  options?: CreateSagaAggregateOptions<TState> & { aggregateName?: TAggregateName }
): BuiltSagaAggregate<TAggregateName, TState>;
export function createSagaAggregate<TAggregateName extends string, TState = unknown>(
  options: CreateSagaAggregateOptions<TState> & { aggregateName: TAggregateName }
): BuiltSagaAggregate<TAggregateName, TState>;
export function createSagaAggregate(options: CreateSagaAggregateOptions<unknown> & { aggregateName?: string } = {}): BuiltSagaAggregate<string, unknown> {
  if (options.aggregateName !== undefined) return buildSagaAggregate(options.aggregateName, options);
  return buildSagaAggregate('saga', options);
}

export type SagaAggregate<TState = unknown> = BuiltSagaAggregate<string, TState>;
