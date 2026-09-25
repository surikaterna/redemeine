import { createSaga, defineRequestResponse, defineSagaPlugin, runSagaStartHandler } from '@redemeine/saga';
import type { Draft } from 'immer';

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
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [plugin] as const, responseHandlers: bindings });
// @ts-expect-error start input mismatch
void runSagaStartHandler({ definition, metadata, startInput: { wrong: 'ok' }, plugins: [plugin] as const, responseHandlers: bindings });
// @ts-expect-error plugin manifest tuple mismatch
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [], responseHandlers: bindings });
// @ts-expect-error token phase mismatch
void runSagaStartHandler({ definition, metadata, startInput: { id: 'ok' }, plugins: [plugin] as const, responseHandlers: { ...bindings, done: { phase: 'error' } } });
