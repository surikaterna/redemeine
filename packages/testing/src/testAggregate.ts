type CommandEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly id?: string;
  readonly headers?: unknown;
  readonly metadata?: unknown;
};

type EventEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly id?: string;
  readonly headers?: unknown;
  readonly metadata?: unknown;
};

type AggregateCommandCreators = Record<string, (...args: any[]) => CommandEnvelope>;

type AggregateDefinition<TState, TCommandCreators extends AggregateCommandCreators> = {
  readonly initialState: TState;
  readonly apply: (state: TState, event: EventEnvelope) => TState;
  readonly process: (state: TState, command: CommandEnvelope) => readonly EventEnvelope[];
  readonly commandCreators: TCommandCreators;
};

type StateMatcher<TState> = (state: TState) => boolean | void;

type ComparableEvent = {
  readonly type: string;
  readonly payload: unknown;
  readonly headers?: unknown;
  readonly metadata?: unknown;
};

function areEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function eventForComparison(event: EventEnvelope): ComparableEvent {
  const comparableMetadata =
    event.metadata && typeof event.metadata === 'object'
      ? (() => {
          const metadata = { ...(event.metadata as Record<string, unknown>) };
          if ('command' in metadata) {
            delete metadata.command;
          }

          return Object.keys(metadata).length > 0 ? metadata : undefined;
        })()
      : event.metadata;

  return {
    type: event.type,
    payload: event.payload,
    headers: event.headers,
    metadata: comparableMetadata
  };
}

function assertWhenReady(hasRunWhen: boolean, operation: string): void {
  if (!hasRunWhen) {
    throw new Error(`then(${operation}) failed: call when(...) first`);
  }
}

function assertWhenDidNotThrow(error: unknown, operation: string): void {
  if (error === undefined) {
    return;
  }

  if (error instanceof Error) {
    throw new Error(`then(${operation}) failed: when phase threw ${error.name}: ${error.message}`);
  }

  throw new Error(`then(${operation}) failed: when phase threw ${String(error)}`);
}

export interface TestAggregateFixture<TState, TCommandCreators extends AggregateCommandCreators> {
  given(events: readonly EventEnvelope[]): TestAggregateFixture<TState, TCommandCreators>;
  when(command: CommandEnvelope): TestAggregateFixture<TState, TCommandCreators>;
  when<TName extends keyof TCommandCreators & string>(
    command: TName,
    ...args: Parameters<TCommandCreators[TName]>
  ): TestAggregateFixture<TState, TCommandCreators>;
  expectEvents(expected: readonly EventEnvelope[]): TestAggregateFixture<TState, TCommandCreators>;
  expectError<TError extends Error>(
    errorClass: abstract new (...args: any[]) => TError,
    message?: string
  ): TestAggregateFixture<TState, TCommandCreators>;
  expectState(expected: TState | StateMatcher<TState>): TestAggregateFixture<TState, TCommandCreators>;
  expectNoEvents(): TestAggregateFixture<TState, TCommandCreators>;
  getState(): TState;
  getEmittedEvents(): readonly EventEnvelope[];
  getError(): unknown;
}

export function testAggregate<TState, TCommandCreators extends AggregateCommandCreators>(
  aggregate: AggregateDefinition<TState, TCommandCreators>
): TestAggregateFixture<TState, TCommandCreators> {
  let hydratedState: TState = aggregate.initialState;
  let stateAfterWhen: TState = aggregate.initialState;
  let emittedEvents: readonly EventEnvelope[] = [];
  let thrownError: unknown = undefined;
  let hasRunWhen = false;

  const fixture: TestAggregateFixture<TState, TCommandCreators> = {
    given(events) {
      try {
        hydratedState = events.reduce<TState>((nextState, event) => aggregate.apply(nextState, event), aggregate.initialState);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`given phase failed: ${error.message}`);
        }

        throw new Error(`given phase failed: ${String(error)}`);
      }

      stateAfterWhen = hydratedState;
      emittedEvents = [];
      thrownError = undefined;
      hasRunWhen = false;
      return fixture;
    },

    when(commandOrName: CommandEnvelope | (keyof TCommandCreators & string), ...args: unknown[]) {
      let command: CommandEnvelope;

      if (typeof commandOrName === 'string') {
        const commandCreator = aggregate.commandCreators[commandOrName];
        if (typeof commandCreator !== 'function') {
          throw new Error(`when phase failed: unknown command creator "${commandOrName}"`);
        }

        command = commandCreator(...(args as never[]));
      } else {
        command = commandOrName;
      }

      hasRunWhen = true;
      emittedEvents = [];
      thrownError = undefined;
      stateAfterWhen = hydratedState;

      try {
        const processed = aggregate.process(hydratedState, command);
        emittedEvents = [...processed];
        stateAfterWhen = emittedEvents.reduce<TState>((nextState, event) => aggregate.apply(nextState, event), hydratedState);
      } catch (error) {
        thrownError = error;
      }

      return fixture;
    },

    expectEvents(expected) {
      assertWhenReady(hasRunWhen, 'expectEvents');
      assertWhenDidNotThrow(thrownError, 'expectEvents');

      const actualComparable = emittedEvents.map(eventForComparison);
      const expectedComparable = expected.map(eventForComparison);
      if (!areEqual(actualComparable, expectedComparable)) {
        throw new Error(
          `then(expectEvents) mismatch\nexpected: ${JSON.stringify(expectedComparable)}\nactual: ${JSON.stringify(actualComparable)}`
        );
      }

      return fixture;
    },

    expectError(errorClass, message) {
      assertWhenReady(hasRunWhen, 'expectError');

      if (thrownError === undefined) {
        throw new Error(`then(expectError) mismatch: expected ${errorClass.name} but when phase did not throw`);
      }

      if (!(thrownError instanceof errorClass)) {
        const actualName = thrownError instanceof Error ? thrownError.constructor.name : typeof thrownError;
        throw new Error(`then(expectError) mismatch: expected ${errorClass.name} but received ${actualName}`);
      }

      if (message !== undefined && thrownError.message !== message) {
        throw new Error(
          `then(expectError) message mismatch\nexpected: ${JSON.stringify(message)}\nactual: ${JSON.stringify(thrownError.message)}`
        );
      }

      return fixture;
    },

    expectState(expected) {
      assertWhenReady(hasRunWhen, 'expectState');

      if (typeof expected === 'function') {
        const matcherResult = (expected as StateMatcher<TState>)(stateAfterWhen);
        if (matcherResult === false) {
          throw new Error('then(expectState) mismatch: matcher returned false');
        }

        return fixture;
      }

      if (!areEqual(stateAfterWhen, expected)) {
        throw new Error(
          `then(expectState) mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(stateAfterWhen)}`
        );
      }

      return fixture;
    },

    expectNoEvents() {
      assertWhenReady(hasRunWhen, 'expectNoEvents');
      if (emittedEvents.length !== 0) {
        throw new Error(`then(expectNoEvents) mismatch: expected no events but received ${emittedEvents.length}`);
      }

      return fixture;
    },

    getState() {
      return stateAfterWhen;
    },

    getEmittedEvents() {
      return emittedEvents;
    },

    getError() {
      return thrownError;
    }
  };

  return fixture;
}
