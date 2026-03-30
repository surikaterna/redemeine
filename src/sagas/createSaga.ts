export type SagaInitialStateFactory<TState> = () => TState;

export type SagaCorrelationFactory = (...args: unknown[]) => unknown;

export type SagaHandlers = Record<string, (...args: unknown[]) => unknown>;

export interface SagaDefinition {
  initialState: SagaInitialStateFactory<unknown>;
  correlations: Array<{ aggregate: string; correlate: SagaCorrelationFactory }>;
  handlers: Array<{ aggregate: string; handlers: SagaHandlers }>;
}

export interface SagaBuilder {
  initialState<TState>(factory: SagaInitialStateFactory<TState>): SagaBuilder;
  correlate(aggregate: string, correlate: SagaCorrelationFactory): SagaBuilder;
  on(aggregate: string, handlers: SagaHandlers): SagaBuilder;
  build(): SagaDefinition;
}

/**
 * Scaffold for saga fluent API.
 * Runtime behavior is intentionally skeletal in S02.
 */
export function createSaga(): SagaBuilder {
  const state: SagaDefinition = {
    initialState: () => undefined,
    correlations: [],
    handlers: []
  };

  const builder: SagaBuilder = {
    initialState(factory) {
      state.initialState = factory as SagaInitialStateFactory<unknown>;
      return builder;
    },
    correlate(aggregate, correlate) {
      state.correlations.push({ aggregate, correlate });
      return builder;
    },
    on(aggregate, handlers) {
      state.handlers.push({ aggregate, handlers });
      return builder;
    },
    build() {
      return state;
    }
  };

  return builder;
}
