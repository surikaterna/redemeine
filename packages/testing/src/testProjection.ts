import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';

export interface TestProjectionEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sequence: number;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TestProjectionContext {
  subscribeTo(aggregate: { __aggregateType: string }, aggregateId: string): void;
  unsubscribeFrom(aggregate: { __aggregateType: string }, aggregateId: string): void;
  getSubscriptions(): Array<{ aggregate: { __aggregateType: string }; aggregateId: string }>;
}

export interface TestProjectionDefinition<TState> {
  readonly fromStream: {
    readonly aggregate: { __aggregateType: string };
    readonly handlers: Record<string, (state: Draft<TState>, event: TestProjectionEvent, ctx: TestProjectionContext) => void>;
  };
  readonly joinStreams?: readonly {
    readonly aggregate: { __aggregateType: string };
    readonly handlers: Record<string, (state: Draft<TState>, event: TestProjectionEvent, ctx: TestProjectionContext) => void>;
  }[];
  readonly initialState: (documentId: string) => TState;
}

enablePatches();

export type TestProjectionApplyResult<TState> = {
  readonly state: TState;
  readonly patches: readonly Patch[];
};

export interface TestProjectionFixture<TState> {
  withState(state: TState): TestProjectionFixture<TState>;
  applyEvent(event: TestProjectionEvent): TestProjectionApplyResult<TState>;
  getState(): TState;
}

function createContext(): TestProjectionContext {
  const subscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];
  const unsubscriptions: Array<{ aggregate: { __aggregateType: string }; aggregateId: string }> = [];

  return {
    subscribeTo(aggregate, aggregateId) {
      subscriptions.push({ aggregate, aggregateId });
    },
    unsubscribeFrom(aggregate, aggregateId) {
      unsubscriptions.push({ aggregate, aggregateId });
    },
    getSubscriptions() {
      const remaining = new Map<string, { aggregate: { __aggregateType: string }; aggregateId: string }>();

      for (const subscription of subscriptions) {
        remaining.set(`${subscription.aggregate.__aggregateType}:${subscription.aggregateId}`, subscription);
      }

      for (const unsubscription of unsubscriptions) {
        remaining.delete(`${unsubscription.aggregate.__aggregateType}:${unsubscription.aggregateId}`);
      }

      return Array.from(remaining.values());
    }
  };
}

function getHandlerCandidateKeys(event: TestProjectionEvent): string[] {
  const keys = new Set<string>();
  const eventType = event.type;
  const aggregatePrefix = `${event.aggregateType}.`;
  const hasAggregatePrefix = eventType.startsWith(aggregatePrefix);
  const hasEventSuffix = eventType.endsWith('.event');

  keys.add(eventType);

  if (hasAggregatePrefix) {
    keys.add(eventType.slice(aggregatePrefix.length));
  }

  if (hasEventSuffix) {
    const withoutEventSuffix = eventType.slice(0, -'.event'.length);
    keys.add(withoutEventSuffix);

    if (withoutEventSuffix.startsWith(aggregatePrefix)) {
      keys.add(withoutEventSuffix.slice(aggregatePrefix.length));
    }
  }

  return Array.from(keys);
}

function findHandler<TState>(
  projection: TestProjectionDefinition<TState>,
  event: TestProjectionEvent
): ((state: Draft<TState>, event: TestProjectionEvent, ctx: TestProjectionContext) => void) | null {
  const resolve = (
    handlers: Record<string, (state: Draft<TState>, event: TestProjectionEvent, ctx: TestProjectionContext) => void>
  ): ((state: Draft<TState>, event: TestProjectionEvent, ctx: TestProjectionContext) => void) | null => {
    const candidateKeys = getHandlerCandidateKeys(event);
    for (const key of candidateKeys) {
      const handler = handlers[key];
      if (handler) {
        return handler;
      }
    }

    return null;
  };

  if (event.aggregateType === projection.fromStream.aggregate.__aggregateType) {
    return resolve(projection.fromStream.handlers);
  }

  for (const joinStream of projection.joinStreams || []) {
    if (event.aggregateType === joinStream.aggregate.__aggregateType) {
      return resolve(joinStream.handlers);
    }
  }

  return null;
}

export function testProjection<TState>(projection: TestProjectionDefinition<TState>): TestProjectionFixture<TState> {
  let state = projection.initialState('test-projection');

  const fixture: TestProjectionFixture<TState> = {
    withState(nextState: TState) {
      state = nextState;
      return fixture;
    },
    applyEvent(event: TestProjectionEvent) {
      const context = createContext();
      const handler = findHandler(projection, event);

      const [nextState, patches] = produceWithPatches(state, (draft) => {
        if (handler) {
          handler(draft, event, context);
        }
      });

      state = nextState;

      return {
        state,
        patches
      };
    },
    getState() {
      return state;
    }
  };

  return fixture;
}
