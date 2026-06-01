import {
  runSagaErrorHandler,
  runSagaHandler,
  runSagaResponseHandler,
  type SagaDefinition,
  type SagaErrorTokenKey,
  type SagaExecutableHandlerFailureReason,
  type SagaIntent,
  type SagaIntentMetadata,
  type SagaPluginManifestList,
  type SagaReducerOutput,
  type SagaResponseHandlerTokenBinding,
  type SagaResponseHandlerTokenBindings,
  type SagaResponseTokenKey
} from '@redemeine/saga';
import {
  areEqual,
  assertMatches,
  resolveMetadata,
  resolveHandlerForEvent,
  enqueuePluginRequests,
  dequeueRequest,
  type TestSagaQueuedRequest
} from './sagaHelpers';

type SagaEventEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly metadata?: Partial<SagaIntentMetadata>;
};

export interface TestSagaOptions<TPlugins extends SagaPluginManifestList = readonly []> {
  readonly plugins?: TPlugins;
}

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
  invokeResponse<TToken extends SagaResponseTokenKey<TResponseHandlerBindings>>(
    token: TToken,
    payload: unknown
  ): Promise<TestSagaInvokeResult<TState, TToken>>;
  invokeError<TToken extends SagaErrorTokenKey<TResponseHandlerBindings>>(
    token: TToken,
    error: unknown
  ): Promise<TestSagaInvokeResult<TState, TToken>>;
  expectState(expected: TState | ((state: TState) => boolean | void)): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>;
  expectIntents(
    expected: readonly SagaIntent[] | ((intents: readonly SagaIntent[]) => boolean | void)
  ): TestSagaFixture<TState, TPlugins, TResponseHandlerBindings>;
  getState(): TState;
  getIntents(): readonly SagaIntent[];
}

/**
 * Creates a test fixture for unit testing saga definitions in isolation.
 *
 * The fixture provides a fluent API to set state, receive events, invoke
 * response/error handlers, and assert on resulting state and intents.
 *
 * @example
 * ```typescript
 * const fixture = testSaga(PaymentSaga);
 * await fixture
 *   .receiveEvent({ type: 'order.placed.event', payload: { orderId: '1' } })
 *   .expectIntents([{ type: 'processPayment', payload: { orderId: '1' } }]);
 * ```
 *
 * @param definition - The compiled saga definition to test
 * @param options - Optional plugin configuration
 * @returns A fluent test fixture for saga assertions
 * @since 0.1.0
 */
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
  const knownResponseTokens = new Set(Object.keys(definition.responseHandlers));
  const knownErrorTokens = new Set(Object.keys(definition.errorHandlers));

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
    async invokeResponse<TToken extends SagaResponseTokenKey<TResponseHandlerBindings>>(
      token: TToken,
      payload: unknown
    ): Promise<TestSagaInvokeResult<TState, TToken>> {
      if (!knownResponseTokens.has(token)) {
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
    async invokeError<TToken extends SagaErrorTokenKey<TResponseHandlerBindings>>(
      token: TToken,
      error: unknown
    ): Promise<TestSagaInvokeResult<TState, TToken>> {
      if (!knownErrorTokens.has(token)) {
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
