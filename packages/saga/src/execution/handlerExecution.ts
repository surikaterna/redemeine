import { createDraft, finishDraft, type Draft } from 'immer';
import { createSagaDispatchContext } from '../createSaga';
import type {
  RunSagaErrorHandlerInput,
  RunSagaResponseHandlerInput,
  SagaAggregateDefinition,
  SagaAggregateEventByName,
  SagaAggregateEventName,
  SagaErrorCallbackEnvelope,
  SagaErrorTokenKey,
  SagaExecutableHandlerResult,
  SagaHandler,
  SagaHandlerResult,
  SagaIntent,
  SagaIntentContext,
  SagaIntentMetadata,
  SagaPluginManifestList,
  SagaReducerOutput,
  SagaResponseCallbackEnvelope,
  SagaResponseTokenKey,
  TErrorToken,
  TResponseToken
} from '../createSaga';
import type {
  SagaBindingsFromErrorHandlers,
  SagaBindingsFromResponseHandlers,
  SagaBindingsFromRetryHandlers,
  SagaResponseHandlerTokenBinding,
  SagaResponseHandlerTokenBindings
} from '../definition/responseTokens';

function resolveIntentMetadata(
  request: SagaResponseCallbackEnvelope['request'],
  override?: Partial<SagaIntentMetadata>
): SagaIntentMetadata {
  return {
    sagaId: override?.sagaId ?? request.sagaId ?? 'unknown-saga-id',
    correlationId: override?.correlationId ?? request.correlationId ?? 'unknown-correlation-id',
    causationId: override?.causationId ?? request.causationId ?? 'unknown-causation-id'
  };
}

function createTokenBindingsFromHandlerMaps<
  TResponseHandlers extends Record<string, unknown>,
  TErrorHandlers extends Record<string, unknown>,
  TRetryHandlers extends Record<string, unknown>
>(
  responseHandlers: TResponseHandlers,
  errorHandlers: TErrorHandlers,
  retryHandlers: TRetryHandlers
): SagaBindingsFromResponseHandlers<TResponseHandlers>
  & SagaBindingsFromErrorHandlers<TErrorHandlers>
  & SagaBindingsFromRetryHandlers<TRetryHandlers> {
  const bindings: Record<string, SagaResponseHandlerTokenBinding> = {};

  for (const token of Object.keys(responseHandlers)) {
    bindings[token] = { phase: 'response' };
  }

  for (const token of Object.keys(errorHandlers)) {
    bindings[token] = { phase: 'error' };
  }

  for (const token of Object.keys(retryHandlers)) {
    bindings[token] = { phase: 'retry' };
  }

  // SAFETY: The bindings are built from each handler map's own keys and fixed phase.
  return bindings as SagaBindingsFromResponseHandlers<TResponseHandlers>
    & SagaBindingsFromErrorHandlers<TErrorHandlers>
    & SagaBindingsFromRetryHandlers<TRetryHandlers>;
}

function hasOwnToken(handlers: Record<string, unknown> | undefined, token: string): boolean {
  if (handlers === undefined) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(handlers, token);
}

function createFailureResult<TToken extends string>(
  token: TToken,
  reason: 'token_not_defined' | 'handler_not_registered'
): SagaExecutableHandlerResult<never, TToken> {
  return { ok: false, reason, token };
}

function createCallbackExecutionContext<
  TState,
  TPlugins extends SagaPluginManifestList,
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings
>(
  state: TState,
  definition: RunSagaResponseHandlerInput<TState, TPlugins, TResponseHandlerBindings>['definition'],
  request: SagaResponseCallbackEnvelope['request'],
  intentMetadata: Partial<SagaIntentMetadata> | undefined,
  plugins: TPlugins
) {
  // SAFETY: Immer's `createDraft` type is object-bounded, while saga state is
  // intentionally generic for public API compatibility. Runtime behavior is
  // unchanged: callers must still provide draftable saga state.
  const draft = createDraft(state as any);
  const intents: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TResponseHandlerBindings>(
    resolveIntentMetadata(request, intentMetadata),
    intents,
    createTokenBindingsFromHandlerMaps(
      definition.responseHandlers,
      definition.errorHandlers,
      definition.retryHandlers
    ) as TResponseHandlerBindings,
    plugins
  );

  return { draft, intents, ctx };
}

function createSuccessResult<TState, TToken extends string>(
  draft: Draft<TState>,
  intents: SagaIntent[],
  token: TToken
): SagaExecutableHandlerResult<TState, TToken> {
  return {
    ok: true,
    output: {
      state: finishDraft(draft) as TState,
      intents
    },
    token
  };
}

/**
 * Executes a single saga handler with mutation-first semantics and produces
 * deterministic reducer output.
 */
export async function runSagaHandler<
  TState,
  TAggregate extends SagaAggregateDefinition,
  TEventName extends SagaAggregateEventName<TAggregate>,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
>(
  state: TState,
  event: SagaAggregateEventByName<TAggregate, TEventName>,
  handler: SagaHandler<TState, TAggregate, TEventName, TPlugins, TResponseHandlerBindings>,
  metadata: SagaIntentMetadata,
  responseHandlers: TResponseHandlerBindings = {} as TResponseHandlerBindings,
  plugins: TPlugins = [] as unknown as TPlugins
): Promise<SagaReducerOutput<TState>> {
  // SAFETY: See `createCallbackExecutionContext`; preserving the unbounded
  // public `TState` avoids a breaking API constraint.
  const draft = createDraft(state as any);
  const intentBuffer: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TResponseHandlerBindings>(
    metadata,
    intentBuffer,
    responseHandlers,
    plugins
  );

  await handler(draft as Draft<TState>, event, ctx);

  return {
    state: finishDraft(draft) as TState,
    intents: intentBuffer
  };
}

export async function runSagaResponseHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>> =
    TResponseToken<SagaResponseTokenKey<TResponseHandlerBindings>>,
  TPayload = unknown
>(
  input: RunSagaResponseHandlerInput<TState, TPlugins, TResponseHandlerBindings, TToken, TPayload>
): Promise<SagaExecutableHandlerResult<TState, TToken>> {
  const {
    definition,
    state,
    envelope,
    intentMetadata,
    plugins = [] as unknown as TPlugins
  } = input;
  const token = envelope.token;
  if (!hasOwnToken(definition.responseHandlers as Record<string, unknown>, token)) {
    return createFailureResult(token, 'token_not_defined');
  }

  const handler = (definition.responseHandlers as Record<
    string,
    ((
      state: Draft<TState>,
      response: SagaResponseCallbackEnvelope<TToken, TPayload>,
      ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
    ) => SagaHandlerResult) | undefined
  >)[token];

  if (handler === undefined) {
    return createFailureResult(token, 'handler_not_registered');
  }

  const { draft, intents, ctx } = createCallbackExecutionContext(
    state,
    definition,
    envelope.request,
    intentMetadata,
    plugins
  );

  await handler(draft as Draft<TState>, envelope, ctx);

  return createSuccessResult(draft, intents, token);
}

export async function runSagaErrorHandler<
  TState,
  TPlugins extends SagaPluginManifestList = readonly [],
  TResponseHandlerBindings extends SagaResponseHandlerTokenBindings = Record<never, never>,
  TToken extends TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>> =
    TErrorToken<SagaErrorTokenKey<TResponseHandlerBindings>>,
  TError = unknown
>(
  input: RunSagaErrorHandlerInput<TState, TPlugins, TResponseHandlerBindings, TToken, TError>
): Promise<SagaExecutableHandlerResult<TState, TToken>> {
  const {
    definition,
    state,
    envelope,
    intentMetadata,
    plugins = [] as unknown as TPlugins
  } = input;
  const token = envelope.token;
  if (!hasOwnToken(definition.errorHandlers as Record<string, unknown>, token)) {
    return createFailureResult(token, 'token_not_defined');
  }

  const handler = (definition.errorHandlers as Record<
    string,
    ((
      state: Draft<TState>,
      error: SagaErrorCallbackEnvelope<TToken, TError>,
      ctx: SagaIntentContext<TPlugins, TResponseHandlerBindings>
    ) => SagaHandlerResult) | undefined
  >)[token];

  if (handler === undefined) {
    return createFailureResult(token, 'handler_not_registered');
  }

  const { draft, intents, ctx } = createCallbackExecutionContext(
    state,
    definition,
    envelope.request,
    intentMetadata,
    plugins
  );

  await handler(draft as Draft<TState>, envelope, ctx);

  return createSuccessResult(draft, intents, token);
}
