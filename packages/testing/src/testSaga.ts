import {
  runSagaErrorHandler,
  runSagaHandler,
  runSagaResponseHandler,
  type SagaAggregateDefinition,
  type SagaDefinition,
  type SagaExecutableHandlerFailureReason,
  type SagaIntent,
  type SagaIntentMetadata,
  type SagaPluginManifestList,
  type SagaPluginRequestIntent,
  type SagaReducerOutput,
  type SagaResponseHandlerTokenBinding,
  type SagaResponseHandlerTokenBindings
} from '@redemeine/saga';

type SagaEventEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly metadata?: Partial<SagaIntentMetadata>;
};

type TestSagaQueuedRequest = {
  readonly requestId: number;
  readonly token: string;
  readonly peerToken: string;
  readonly request: {
    readonly plugin_key: string;
    readonly action_name: string;
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
};

export type TestSagaInvokeFailureReason =
  | 'unknown_token'
  | 'queue_empty'
  | SagaExecutableHandlerFailureReason;

export type TestSagaInvokeSuccess<TState, TToken extends string = string> = {
  readonly ok: true;
  readonly token: TToken;
  readonly output: SagaReducerOutput<TState>;
};

export type TestSagaInvokeFailure<TToken extends string = string> = {
  readonly ok: false;
  readonly token: TToken;
  readonly reason: TestSagaInvokeFailureReason;
};

export type TestSagaInvokeResult<TState, TToken extends string = string> =
  | TestSagaInvokeSuccess<TState, TToken>
  | TestSagaInvokeFailure<TToken>;

export interface TestSagaFixture<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> {
  withState(state: TState): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>;
  receiveEvent(event: SagaEventEnvelope): Promise<TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>>;
  invokeResponse(token: string, payload: unknown): Promise<TestSagaInvokeResult<TState>>;
  invokeError(token: string, error: unknown): Promise<TestSagaInvokeResult<TState>>;
  expectState(expected: TState | ((state: TState) => boolean | void)): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>;
  expectIntents(
    expected: readonly SagaIntent[] | ((intents: readonly SagaIntent[]) => boolean | void)
  ): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>;
  getState(): TState;
  getIntents(): readonly SagaIntent[];
}

export interface TestSagaOptions<TPlugins extends SagaPluginManifestList = readonly []> {
  readonly plugins?: TPlugins;
}

function areEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertMatches<TActual>(
  label: string,
  actual: TActual,
  expected: TActual | ((value: TActual) => boolean | void)
): void {
  if (typeof expected === 'function') {
    const matcher = expected as (value: TActual) => boolean | void;
    const result = matcher(actual);
    if (result === false) {
      throw new Error(`${label} expectation returned false`);
    }

    return;
  }

  if (!areEqual(actual, expected)) {
    throw new Error(`${label} mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`);
  }
}

function resolveMetadata(metadata?: Partial<SagaIntentMetadata>): SagaIntentMetadata {
  return {
    sagaId: metadata?.sagaId ?? 'test-saga',
    correlationId: metadata?.correlationId ?? 'test-correlation',
    causationId: metadata?.causationId ?? 'test-causation'
  };
}

function resolveHandlerForEvent(
  definition: SagaDefinition<any, any, any>,
  event: SagaEventEnvelope
): {
  readonly aggregate: SagaAggregateDefinition;
  readonly handler: (...args: any[]) => unknown;
} | null {
  for (const registration of definition.handlers) {
    if (event.aggregateType !== undefined && registration.aggregateType !== event.aggregateType) {
      continue;
    }

    const explicit = registration.handlers[event.type];
    if (explicit !== undefined) {
      return {
        aggregate: registration.aggregate,
        handler: explicit
      };
    }

    const aggregatePrefix = `${registration.aggregateType}.`;
    const aggregateSuffix = '.event';

    if (event.type.startsWith(aggregatePrefix) && event.type.endsWith(aggregateSuffix)) {
      const eventName = event.type.slice(aggregatePrefix.length, -aggregateSuffix.length);
      const derived = registration.handlers[eventName];
      if (derived !== undefined) {
        return {
          aggregate: registration.aggregate,
          handler: derived
        };
      }
    }
  }

  return null;
}

function enqueuePluginRequests(
  intents: readonly SagaIntent[],
  responseQueues: Map<string, TestSagaQueuedRequest[]>,
  errorQueues: Map<string, TestSagaQueuedRequest[]>,
  nextRequestId: { current: number }
): void {
  for (const intent of intents) {
    if (intent.type !== 'plugin-request') {
      continue;
    }

    const pluginRequest = intent as SagaPluginRequestIntent;
    const requestId = ++nextRequestId.current;

    const requestBase = {
      plugin_key: pluginRequest.plugin_key,
      action_name: pluginRequest.action_name,
      sagaId: pluginRequest.metadata.sagaId,
      correlationId: pluginRequest.metadata.correlationId,
      causationId: pluginRequest.metadata.causationId
    };

    const responseItem: TestSagaQueuedRequest = {
      requestId,
      token: pluginRequest.routing_metadata.response_handler_key,
      peerToken: pluginRequest.routing_metadata.error_handler_key,
      request: requestBase
    };

    const errorItem: TestSagaQueuedRequest = {
      requestId,
      token: pluginRequest.routing_metadata.error_handler_key,
      peerToken: pluginRequest.routing_metadata.response_handler_key,
      request: requestBase
    };

    const responseQueue = responseQueues.get(responseItem.token) ?? [];
    responseQueue.push(responseItem);
    responseQueues.set(responseItem.token, responseQueue);

    const errorQueue = errorQueues.get(errorItem.token) ?? [];
    errorQueue.push(errorItem);
    errorQueues.set(errorItem.token, errorQueue);
  }
}

function dequeueRequest(
  primaryQueue: Map<string, TestSagaQueuedRequest[]>,
  secondaryQueue: Map<string, TestSagaQueuedRequest[]>,
  token: string
): TestSagaQueuedRequest | undefined {
  const queue = primaryQueue.get(token);
  if (queue === undefined || queue.length === 0) {
    return undefined;
  }

  const next = queue.shift();
  if (queue.length === 0) {
    primaryQueue.delete(token);
  }

  if (next === undefined) {
    return undefined;
  }

  const peerQueue = secondaryQueue.get(next.peerToken);
  if (peerQueue !== undefined) {
    const peerIndex = peerQueue.findIndex((item) => item.requestId === next.requestId);
    if (peerIndex >= 0) {
      peerQueue.splice(peerIndex, 1);
    }

    if (peerQueue.length === 0) {
      secondaryQueue.delete(next.peerToken);
    }
  }

  return next;
}

export function testSaga<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
>(
  definition: SagaDefinition<TState, TPlugins, TResponseHandlerBindings>,
  options?: TestSagaOptions<TPlugins>
): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings> {
  let state = definition.initialState();
  let latestIntents: readonly SagaIntent[] = [];
  const runtimePlugins = options?.plugins ?? ([] as unknown as TPlugins);
  const responseQueues = new Map<string, TestSagaQueuedRequest[]>();
  const errorQueues = new Map<string, TestSagaQueuedRequest[]>();
  const requestCounter = { current: 0 };

  const tokenBindings = Object.freeze({
    ...Object.fromEntries(Object.keys(definition.responseHandlers).map((token) => [token, { phase: 'response' as const }])),
    ...Object.fromEntries(Object.keys(definition.errorHandlers).map((token) => [token, { phase: 'error' as const }])),
    ...Object.fromEntries(Object.keys(definition.retryHandlers).map((token) => [token, { phase: 'retry' as const }]))
  }) as Record<string, SagaResponseHandlerTokenBinding | undefined>;

  const applyOutput = (output: SagaReducerOutput<TState>) => {
    state = output.state;
    latestIntents = output.intents;
    enqueuePluginRequests(output.intents, responseQueues, errorQueues, requestCounter);
  };

  const isKnownTokenForPhase = (token: string, phase: 'response' | 'error') => {
    const tokenBinding = tokenBindings[token];
    return tokenBinding !== undefined && tokenBinding.phase === phase;
  };

  const fixture: TestSagaFixture<TState, TPlugins, TResponseHandlerBindings> = {
    withState(nextState: TState) {
      state = nextState;
      return fixture;
    },
    async receiveEvent(event: SagaEventEnvelope) {
      const resolved = resolveHandlerForEvent(definition, event);
      if (resolved === null) {
        throw new Error(`No saga handler registered for event type "${event.type}"`);
      }

      const output = await runSagaHandler(
        state,
        {
          type: event.type,
          payload: event.payload,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          sequence: event.sequence,
          metadata: event.metadata
        } as any,
        resolved.handler as any,
        resolveMetadata(event.metadata),
        tokenBindings as TResponseHandlerBindings,
        runtimePlugins
      );

      applyOutput(output);
      return fixture;
    },
    async invokeResponse(token: string, payload: unknown) {
      if (!isKnownTokenForPhase(token, 'response')) {
        return {
          ok: false,
          reason: 'unknown_token',
          token
        };
      }

      const request = dequeueRequest(responseQueues, errorQueues, token);
      if (request === undefined) {
        return {
          ok: false,
          reason: 'queue_empty',
          token
        };
      }

      const result = await runSagaResponseHandler({
        definition,
        state,
        envelope: {
          token: token as any,
          payload,
          request: request.request
        },
        plugins: runtimePlugins
      });

      if (!result.ok) {
        const failureReason = (result as { readonly reason: TestSagaInvokeFailureReason }).reason;
        return {
          ok: false,
          reason: failureReason,
          token
        };
      }

      applyOutput(result.output);
      return {
        ok: true,
        token,
        output: result.output
      };
    },
    async invokeError(token: string, error: unknown) {
      if (!isKnownTokenForPhase(token, 'error')) {
        return {
          ok: false,
          reason: 'unknown_token',
          token
        };
      }

      const request = dequeueRequest(errorQueues, responseQueues, token);
      if (request === undefined) {
        return {
          ok: false,
          reason: 'queue_empty',
          token
        };
      }

      const result = await runSagaErrorHandler({
        definition,
        state,
        envelope: {
          token: token as any,
          error,
          request: request.request
        },
        plugins: runtimePlugins
      });

      if (!result.ok) {
        const failureReason = (result as { readonly reason: TestSagaInvokeFailureReason }).reason;
        return {
          ok: false,
          reason: failureReason,
          token
        };
      }

      applyOutput(result.output);
      return {
        ok: true,
        token,
        output: result.output
      };
    },
    expectState(expected: TState | ((actual: TState) => boolean | void)) {
      assertMatches('state', state, expected);
      return fixture;
    },
    expectIntents(expected: readonly SagaIntent[] | ((intents: readonly SagaIntent[]) => boolean | void)) {
      assertMatches('intents', latestIntents, expected);
      return fixture;
    },
    getState() {
      return state;
    },
    getIntents() {
      return latestIntents;
    }
  };

  return fixture;
}
