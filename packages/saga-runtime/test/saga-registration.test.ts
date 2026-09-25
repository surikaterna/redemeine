import { createSaga, defineRequestResponse, defineSagaPlugin } from '@redemeine/saga';
import { bindSagaRegistrations, registerSagaDefinition } from '../src/routing/registerSagaDefinition';
import { compileSagaRoutes } from '../src/routing/compileSagaRoutes';

const plugin = defineSagaPlugin({ plugin_key: 'remote', version: '1', actions: { ask: defineRequestResponse((id: string) => ({ id })) } });
interface State { readonly count: number; readonly ids: string[] }
const definition = createSaga({ identity: { namespace: 'orders', name: 'register', version: 1 }, plugins: [plugin] as const })
  .initialState((): State => ({ count: 0, ids: [] }))
  .onResponses({ done: () => undefined })
  .onErrors({ failed: () => undefined })
  .onRetries({ again: () => undefined })
  .start<{ id: string }>((state, input, ctx) => {
    state.count++;
    state.ids.push(input.id);
    if (input.id === 'emit') ctx.actions.remote.ask(input.id).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
    void ctx.onRetry.again;
  }).correlateBy((input) => input.id).build();
const bindings = { done: { phase: 'response' }, failed: { phase: 'error' }, again: { phase: 'retry' } } as const;
const parseStartInput = (input: unknown): { id: string } => {
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') throw new TypeError('invalid start input');
  return { id: input.id };
};
const options = { definition, pluginManifests: [plugin] as const, responseHandlerBindings: bindings, parseStartInput };
const metadata = { sagaId: 's', correlationId: 'c', causationId: 'e' };

it('keeps an executable typed start closure and rejects bad trigger input before handler', async () => {
  const registration = registerSagaDefinition(options);
  const decision = await registration.executeStart({ id: 'ok' }, metadata);
  const state: State = decision.state;
  expect(state).toEqual({ count: 1, ids: ['ok'] });
  expect(decision.intents).toEqual([]);
  await expect(registration.executeStart({ wrong: 'ok' }, metadata)).rejects.toThrow('invalid start input');
  expect((await registration.executeStart({ id: 'emit' }, metadata)).intents).toHaveLength(1);
});

it('rejects wrong, missing and duplicate executable metadata', () => {
  const invalid = (changes: object) => () => registerSagaDefinition({ ...options, ...changes });
  expect(invalid({ pluginManifests: [] })).toThrow();
  expect(invalid({ pluginManifests: [plugin, plugin] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, plugin_key: 'other' }] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, version: '2' }] })).toThrow();
  expect(invalid({ pluginManifests: [{ plugin_key: 'remote', actions: plugin.actions }] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, actions: {} }] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, actions: { ask: { interaction: 'broken', build: () => ({}) } } }] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, actions: { ask: { interaction: 'request_response', build: null } } }] })).toThrow();
  expect(invalid({ pluginManifests: [{ ...plugin, actions: { ...plugin.actions, extra: plugin.actions.ask } }] })).toThrow();
  expect(invalid({ responseHandlerBindings: { done: bindings.done } })).toThrow();
  expect(invalid({ responseHandlerBindings: { ...bindings, extra: bindings.done } })).toThrow();
  expect(invalid({ responseHandlerBindings: { ...bindings, done: { phase: 'error' } } })).toThrow();
  expect(invalid({ definition: { ...definition, sagaKey: 'other' } })).toThrow();
  expect(invalid({ definition: { ...definition, identity: { ...definition.identity, version: 2 } } })).toThrow();
  expect(invalid({ definition: { ...definition, plugins: [{ ...definition.plugins[0], action_names: ['ask', 'ask'] }] } })).toThrow();
  expect(invalid({ definition: { ...definition, responseHandlers: { ...definition.responseHandlers, failed: () => undefined } } })).toThrow();
});

it('rejects non-plain initial state and invalid output before a decision escapes', async () => {
  for (const state of [[], new Date(), null, { n: Number.NaN }, { nested: new Map() }]) {
    const registration = registerSagaDefinition({ ...options, definition: { ...definition, initialState: () => state } });
    await expect(registration.executeStart({ id: 'ok' }, metadata)).rejects.toThrow();
  }
});

it('joins exact active identity and version only, with no worker execution', () => {
  const registration = registerSagaDefinition(options);
  const table = compileSagaRoutes([definition]);
  const resolve = bindSagaRegistrations(table, [registration]);
  expect(() => bindSagaRegistrations(table, [])).toThrow();
  expect(() => bindSagaRegistrations(table, [registration, registration])).toThrow();
  expect(() => bindSagaRegistrations(table, [registerSagaDefinition({ ...options, definition: { ...definition } })])).toThrow();
  expect(() => resolve({ kind: 'start', definition, sagaKey: definition.sagaKey, definitionVersion: 2 } as Parameters<typeof resolve>[0])).toThrow();
});
