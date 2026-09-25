import { createSaga, createSagaCommandsFor, defineRequestResponse, defineSagaPlugin, runSagaStartHandler } from '@redemeine/saga';
import type { RunSagaStartInput } from '@redemeine/saga';
import type { Draft } from 'immer';

const aggregate = {
  aggregateType: 'order',
  pure: { eventProjectors: {} },
  commandCreators: {
    local: (id: string) => ({ type: 'order.renamed.command' as const, payload: { id } })
  }
};
const commands = createSagaCommandsFor(aggregate, 'a1', {
  sagaId: 's1', correlationId: 'c1', causationId: 'e1'
});
const command: 'order.renamed.command' = commands.local('one').execution_payload.command;
// @ts-expect-error persisted identity is the creator override, not the local method name
const localKey: 'local' = commands.local('one').execution_payload.command;
// @ts-expect-error invalid command creator arguments
commands.local(7);
// @ts-expect-error unknown local command method
commands.missing('one');

const definition = createSaga({ identity: { namespace: 'orders', name: 'consumer', version: 1 } })
  .initialState(() => ({ ids: [] as string[] }))
  .start<{ id: string }>((state, start, ctx) => {
    state.ids.push(start.id);
    ctx.actions.core.dispatch(aggregate, start.id).local(start.id);
    // @ts-expect-error start input is not a number
    const invalidInput: number = start.id;
    // @ts-expect-error draft state has no count member
    state.count = 1;
    void invalidInput;
  })
  .correlateBy((start) => start.id)
  .build();

const metadata = { sagaId: 's1', correlationId: 'c1', causationId: 'e1' };
void runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata, plugins: [], responseHandlers: {} });
// @ts-expect-error built start input retains the start type
void runSagaStartHandler({ definition, startInput: { wrong: 'one' }, metadata, plugins: [], responseHandlers: {} });
// @ts-expect-error plugin manifests must be supplied even for the empty list
void runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata, responseHandlers: {} });
// @ts-expect-error response token bindings must be supplied even when empty
void runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata, plugins: [] });
// @ts-expect-error both runtime registries are required
void runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata });

interface State { readonly count: number; readonly nested: { readonly ids: string[] }; }
const plugin = defineSagaPlugin({ plugin_key: 'remote', actions: { ask: defineRequestResponse((id: string) => ({ id })) } });
const interfaceDefinition = createSaga({ identity: { namespace: 'orders', name: 'interface', version: 1 }, plugins: [plugin] as const })
  .initialState((): State => ({ count: 0, nested: { ids: [] } }))
  .onResponses({ ok: () => undefined })
  .onErrors({ fail: () => undefined })
  .onRetries({ again: () => undefined })
  .start<{ id: string }>(async (state, start, ctx) => {
    const draft: Draft<State> = state;
    await Promise.resolve();
    draft.count += 1;
    draft.nested.ids.push(start.id);
    ctx.actions.remote.ask(start.id).onResponse(ctx.onResponse.ok).onError(ctx.onError.fail);
    void ctx.onRetry.again;
    // @ts-expect-error wrong-phase token
    ctx.actions.remote.ask(start.id).onResponse(ctx.onError.fail);
    // @ts-expect-error missing action
    ctx.actions.remote.missing(start.id);
  }).correlateBy((start) => start.id).build();
const bindings = { ok: { phase: 'response' }, fail: { phase: 'error' }, again: { phase: 'retry' } } as const;
const interfaceResult: Promise<{ state: State; intents: readonly unknown[] }> = runSagaStartHandler({
  definition: interfaceDefinition, startInput: { id: 'one' }, metadata, plugins: [plugin] as const, responseHandlers: bindings
});
// @ts-expect-error interface-shaped state still requires correct start input
void runSagaStartHandler({ definition: interfaceDefinition, startInput: { wrong: 'one' }, metadata, plugins: [plugin] as const, responseHandlers: bindings });
// @ts-expect-error incorrect binding phase
void runSagaStartHandler({ definition: interfaceDefinition, startInput: { id: 'one' }, metadata, plugins: [plugin] as const, responseHandlers: { ...bindings, ok: { phase: 'error' } } });
// @ts-expect-error primitive state cannot be used with the start helper
type StringStart = RunSagaStartInput<string, undefined>;
// @ts-expect-error number is not draftable start state
type NumberStart = RunSagaStartInput<number, undefined>;
// @ts-expect-error null is not draftable start state
type NullStart = RunSagaStartInput<null, undefined>;
void interfaceResult;

const beforeStart = createSaga({ identity: { namespace: 'orders', name: 'before', version: 1 } })
  .initialState(() => ({ old: true }))
  .initialState(() => ({ ids: [] as string[] }));
const awaiting = beforeStart.start<{ id: string }>((state, start) => { state.ids.push(start.id); });
// @ts-expect-error replacing state after start would invalidate the captured handler
awaiting.initialState(() => ({ count: 0 }));
const correlated = awaiting.initialState(() => ({ ids: ['ready'] })).correlateBy((start) => start.id);
// @ts-expect-error correlated phase cannot replace the state type either
correlated.initialState(() => ({ count: 0 }));
correlated.initialState(() => ({ ids: [] as string[] })).build();
void command;
void localKey;
