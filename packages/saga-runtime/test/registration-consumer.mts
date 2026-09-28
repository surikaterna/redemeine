import { createSaga, defineRequestResponse, defineSagaPlugin, runSagaStartHandler } from '@redemeine/saga';
import type { Draft } from 'immer';
import { compileRegisteredSagaRoutes, bindSagaRegistrations, registerSagaDefinition } from '@redemeine/saga-runtime';

interface State { readonly count: number; readonly nested: { readonly ids: string[] } }
const plugin = defineSagaPlugin({ plugin_key: 'remote', version: '1', actions: {
  ask: defineRequestResponse((id: string) => ({ id }))
} });
const aggregate = { aggregateType: 'orders', pure: { eventProjectors: {
  created: (_state: unknown, _event: { payload: { id: string } }) => undefined
} }, commandCreators: {} } as const;
const definition = createSaga({ identity: { namespace: 'orders', name: 'registered', version: 1 }, plugins: [plugin] as const })
  .initialState((): State => ({ count: 0, nested: { ids: [] } }))
  .onResponses({ done: () => undefined })
  .onErrors({ failed: () => undefined })
  .onRetries({ again: () => undefined })
  .on(aggregate, { created: (state, event, ctx) => {
    state.count++;
    state.nested.ids.push(event.payload.id);
    ctx.actions.remote.ask(event.payload.id).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
    void ctx.onRetry.again;
    // @ts-expect-error on handlers preserve action build arguments
    ctx.actions.remote.ask(123);
  } })
  .start<{ id: string }>((state, input, ctx) => {
    const draft: Draft<State> = state;
    draft.count++;
    draft.nested.ids.push(input.id);
    ctx.actions.remote.ask(input.id).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
    void ctx.onRetry.again;
    // @ts-expect-error action arguments remain typed
    ctx.actions.remote.ask(123);
    // @ts-expect-error phase mismatch
    ctx.actions.remote.ask(input.id).onResponse(ctx.onError.failed);
  }).correlateBy((input) => input.id).build();
const metadata = { sagaId: 's', correlationId: 'c', causationId: 'e' };
const bindings = { done: { phase: 'response' }, failed: { phase: 'error' }, again: { phase: 'retry' } } as const;
const parseStartInput = (input: unknown): { id: string } => {
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') throw new TypeError('start input');
  return { id: input.id };
};
const registration = registerSagaDefinition({ definition, pluginManifests: [plugin] as const,
  responseHandlerBindings: bindings, parseStartInput, parseState: (state: unknown): State => {
    if (!state || typeof state !== 'object' || !('count' in state) || typeof state.count !== 'number') throw new TypeError('state');
    return { count: state.count, nested: { ids: [] } };
  }, parseOnEvent: (event: unknown) => {
    if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') throw new TypeError('event');
    return { id: 'event', type: event.type, payload: {} };
  }, canonicalCommandTypes: [] });
interface OtherState { readonly label: string }
const otherDefinition = createSaga({ identity: { namespace: 'orders', name: 'other', version: 1 } })
  .initialState((): OtherState => ({ label: '' }))
  .start<{ id: string }>((state, input) => { state.label = input.id; })
  .correlateBy((input) => input.id).build();
const other = registerSagaDefinition({ definition: otherDefinition, pluginManifests: [] as const,
  responseHandlerBindings: {}, parseStartInput, canonicalCommandTypes: [],
  parseState: (state: unknown): OtherState => {
    if (!state || typeof state !== 'object' || !('label' in state) || typeof state.label !== 'string') throw new TypeError('state');
    return { label: state.label };
  }, parseOnEvent: (event: unknown) => {
    if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') throw new TypeError('event');
    return { id: 'event', type: event.type, payload: {} };
  } });
const table = compileRegisteredSagaRoutes([registration, other]);
void bindSagaRegistrations(table, [registration, other]);
registerSagaDefinition({ definition, pluginManifests: [plugin] as const, responseHandlerBindings: bindings,
  // @ts-expect-error persisted-state parser cannot return another definition's state
  parseStartInput, parseState: (_state: unknown): OtherState => ({ label: '' }), canonicalCommandTypes: [] });
const typedState: Promise<{ state: State; intents: readonly unknown[] }> = registration.executeStart(
  { id: 'ok' }, metadata, { sagaKey: definition.sagaKey, correlation: { type: 'string', value: 'c' }, sourceId: 'src', routeId: 'r' }, '2026-09-25T10:00:00.000Z');
void typedState;
// @ts-expect-error adapter requires an executable plugin tuple
registerSagaDefinition({ definition, pluginManifests: [], responseHandlerBindings: bindings, parseStartInput, canonicalCommandTypes: [] });
// @ts-expect-error adapter rejects a mismatched plugin action tuple
registerSagaDefinition({ definition, pluginManifests: [{ ...plugin, actions: {} }] as const, responseHandlerBindings: bindings, parseStartInput, canonicalCommandTypes: [] });
// @ts-expect-error adapter requires all response/error/retry phases
registerSagaDefinition({ definition, pluginManifests: [plugin] as const, responseHandlerBindings: { ...bindings, done: { phase: 'error' } }, parseStartInput, canonicalCommandTypes: [] });
// @ts-expect-error adapter decoder must produce the definition's start input
registerSagaDefinition({ definition, pluginManifests: [plugin] as const, responseHandlerBindings: bindings, parseStartInput: (_input: unknown) => ({ wrong: 'x' }), canonicalCommandTypes: [] });
// @ts-expect-error input must be unknown, not an assumed decoded shape
registerSagaDefinition({ definition, pluginManifests: [plugin] as const, responseHandlerBindings: bindings, parseStartInput: (input: { id: string }) => input, canonicalCommandTypes: [] });
// @ts-expect-error adapter requires object-shaped start state
registerSagaDefinition({ definition: { ...definition, initialState: () => 'not a draftable record' }, pluginManifests: [plugin] as const, responseHandlerBindings: bindings, parseStartInput, canonicalCommandTypes: [] });
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [plugin] as const, responseHandlers: bindings });
// @ts-expect-error start input mismatch
void runSagaStartHandler({ definition, metadata, startInput: { wrong: 'ok' }, plugins: [plugin] as const, responseHandlers: bindings });
// @ts-expect-error plugin manifest tuple mismatch
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [], responseHandlers: bindings });
// @ts-expect-error token phase mismatch
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [plugin] as const, responseHandlers: { ...bindings, done: { phase: 'error' } } });
