import { createSaga, defineOneWay, defineRequestResponse, defineSagaPlugin } from '@redemeine/saga';
import { bindSagaRegistrations, registerSagaDefinition, SagaStartDecisionError } from '../src/routing/registerSagaDefinition';
import { compileSagaRoutes } from '../src/routing/compileSagaRoutes';
import { deriveSagaInstanceId } from '../src/identity/deterministicIds';
import { serializeSagaCorrelation } from '../src/identity/canonicalCorrelation';
import { decodeIntent, decodeOutcome, encodeIntent, parseIntent } from '../src/intentWire';

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
    if (input.id === 'null') ctx.actions.remote.ask(input.id).withData(null).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
    if (input.id === 'object') ctx.actions.remote.ask(input.id).withData({ id: input.id }).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
    void ctx.onRetry.again;
  }).correlateBy((input) => input.id).build();
const bindings = { done: { phase: 'response' }, failed: { phase: 'error' }, again: { phase: 'retry' } } as const;
const parseStartInput = (input: unknown): { id: string } => {
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') throw new TypeError('invalid start input');
  return { id: input.id };
};
const options = { definition, pluginManifests: [plugin] as const, responseHandlerBindings: bindings, parseStartInput, canonicalCommandTypes: [] };
const origin = { sagaKey: definition.sagaKey, correlation: { type: 'string' as const, value: 'c' }, sourceId: 'e', routeId: 'r' };
const metadata = { sagaId: deriveSagaInstanceId(origin.sagaKey, origin.correlation), correlationId: serializeSagaCorrelation(origin.correlation), causationId: origin.sourceId };
const clock = '2026-09-25T10:00:00.000Z';
const register = () => registerSagaDefinition(options);

it('keeps an executable typed start closure and rejects bad trigger input before handler', async () => {
  const registration = register();
  const decision = await registration.executeStart({ id: 'ok' }, metadata, origin, clock);
  const state: State = decision.state;
  expect(state).toEqual({ count: 1, ids: ['ok'] });
  expect(decision.intents).toEqual([]);
  await expect(registration.executeStart({ wrong: 'ok' }, metadata, origin, clock)).rejects.toThrow('invalid start input');
  const registry = [{ plugin_key: 'remote', actions: [{ name: 'ask', interaction: 'request_response' as const }] }];
  for (const [id, hasData, data] of [['emit', false, undefined], ['null', true, null], ['object', true, { id: 'object' }]] as const) {
    const intents = (await registration.executeStart({ id }, metadata, origin, clock)).intents;
    expect(intents).toHaveLength(1);
    const request = intents[0];
    if (!request || request.kind !== 'plugin' || request.interaction !== 'request_response') throw new Error('request expected');
    expect(Object.hasOwn(request.routing_metadata, 'handler_data')).toBe(hasData);
    expect(request.routing_metadata.handler_data).toEqual(data);
    expect(parseIntent(encodeIntent(request, registry), registry)).toEqual(request);
    const outcome = { schemaVersion: 1, intentId: request.intentId, instanceId: request.instanceId,
      correlationId: metadata.correlationId, result: 'response', token: 'done', value: { ok: true },
      ...(hasData ? { handler_data: data } : {}) };
    expect(decodeOutcome(outcome, request)).toEqual(outcome);
    expect(() => decodeOutcome({ ...outcome, token: 'failed' }, request)).toThrow();
    expect(() => decodeOutcome({ ...outcome, intentId: 'wrong' }, request)).toThrow();
    expect(() => decodeOutcome({ ...outcome, handler_data: hasData ? undefined : null }, request)).toThrow();
    expect(() => decodeIntent({ ...request, routing_metadata: { ...request.routing_metadata, handler_data: undefined } }, registry)).toThrow();
  }
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
    await expect(registration.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toThrow();
  }
});

it('joins exact active identity and version only, with no worker execution', () => {
  const registration = register();
  const table = compileSagaRoutes([definition]);
  const resolve = bindSagaRegistrations(table, [registration]);
  expect(() => bindSagaRegistrations(table, [])).toThrow();
  expect(() => bindSagaRegistrations(table, [registration, registration])).toThrow();
  expect(() => bindSagaRegistrations(table, [registerSagaDefinition({ ...options, definition: { ...definition } })])).toThrow();
  expect(() => resolve({ kind: 'start', definition, sagaKey: definition.sagaKey, definitionVersion: 2 } as Parameters<typeof resolve>[0])).toThrow();
});

it('cannot trust a fixture digest or infer callback equality from declarative identity', () => {
  const second = registerSagaDefinition({ ...options, definition: { ...definition, start: () => undefined } });
  expect(second.definitionIdentity).toEqual(register().definitionIdentity);
  expect(() => bindSagaRegistrations(compileSagaRoutes([definition]), [second])).toThrow();
  expect(() => bindSagaRegistrations(compileSagaRoutes([definition]), [{ ...register(), definitionIdentity: { ...register().definitionIdentity, policySha256: '0'.repeat(64) } }])).toThrow('Untrusted');
  const traced = registerSagaDefinition({ ...options, releaseId: 'unverified-fixture-digest' });
  expect(traced.definitionIdentity).toEqual(register().definitionIdentity);
  expect(traced.releaseId).toBe('unverified-fixture-digest');
  expect(register().releaseId).toBeUndefined();
  expect(() => registerSagaDefinition({ ...options, releaseId: 'secret\nline' })).toThrow();
});

it('refuses mutable registered callbacks, triggers, builds and policy before executing', async () => {
  const changedStart = { ...definition };
  const start = registerSagaDefinition({ ...options, definition: changedStart });
  changedStart.start = () => undefined;
  await expect(start.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toThrow('changed');

  const changedTriggers = { ...definition, startContracts: { ...definition.startContracts, triggers: [...definition.startContracts.triggers] } };
  const triggers = registerSagaDefinition({ ...options, definition: changedTriggers });
  changedTriggers.startContracts.triggers.push({ kind: 'event', toStartInput: () => ({ id: 'bad' }) });
  await expect(triggers.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toThrow('changed');

  const manifest = { ...plugin, actions: { ...plugin.actions } };
  const executable = registerSagaDefinition({ ...options, pluginManifests: [manifest] as const });
  manifest.actions.ask = defineRequestResponse((_id: string) => ({ id: 'changed' }));
  await expect(executable.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toThrow('changed');

  const changedInitial = { ...definition };
  const initial = registerSagaDefinition({ ...options, definition: changedInitial });
  changedInitial.initialState = () => ({ count: 100, ids: [] });
  await expect(initial.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toThrow('changed');

  const schema = { id: 'input', version: 1 };
  const declared = registerSagaDefinition({ ...options, declaredSchemas: [schema] });
  schema.version = 2;
  expect(() => declared.assertCurrent()).toThrow('changed');
});

it('validates every emitted one-way, core timer and request wire intent before returning', async () => {
  const output = defineSagaPlugin({ plugin_key: 'output', actions: { send: defineOneWay((id: string) => ({ id })) } });
  const emitted = createSaga({ identity: { namespace: 'orders', name: 'emissions', version: 1 }, plugins: [output] as const })
    .initialState(() => ({ count: 0 }))
    .start<{ id: string }>((state, input, ctx) => {
      state.count++;
      ctx.actions.output.send(input.id);
      ctx.actions.core.schedule('timer', 1000);
      ctx.actions.core.cancelSchedule('timer');
    }).correlateBy((input) => input.id).build();
  const emittedRegistration = registerSagaDefinition({ definition: emitted, pluginManifests: [output] as const,
    responseHandlerBindings: {}, parseStartInput, canonicalCommandTypes: [] });
  const emittedOrigin = { ...origin, sagaKey: emitted.sagaKey };
  const emittedMetadata = { ...metadata, sagaId: deriveSagaInstanceId(emittedOrigin.sagaKey, origin.correlation) };
  const wire = (await emittedRegistration.executeStart({ id: 'ok' }, emittedMetadata, emittedOrigin, clock)).intents;
  expect(wire.map((intent) => intent.kind)).toEqual(['plugin', 'schedule', 'cancelSchedule']);
  expect(wire.map((intent) => intent.origin.ordinal)).toEqual([0, 1, 2]);
  expect(wire[1]).toMatchObject({ dueAt: '2026-09-25T10:00:01.000Z' });
  await expect(emittedRegistration.executeStart({ id: 'ok' }, emittedMetadata, emittedOrigin, 'invalid')).rejects.toHaveProperty('code', 'invalid_start_intent');
});

it('rejects invalid emitted action, interaction, routing and non-JSON payload with classified failures', async () => {
  for (const corrupt of [
    (intent: object) => Object.defineProperty(intent, 'action_name', { value: 'unknown' }),
    (intent: object) => Object.defineProperty(intent, 'interaction', { value: 'fire_and_forget' }),
    (intent: object) => Object.defineProperty(intent, 'execution_payload', { value: { invalid: () => undefined } }),
    (intent: object) => Object.defineProperty(intent, 'execution_payload', { value: { value: 'x'.repeat(70_000) } }),
    (intent: object) => {
      const cycle: { self?: object } = {};
      cycle.self = cycle;
      Object.defineProperty(intent, 'execution_payload', { value: cycle });
    },
    (intent: object) => Object.defineProperty(intent, 'routing_metadata', { value: { response_handler_key: 'failed', error_handler_key: 'failed', handler_data: {} } })
  ]) {
    const corrupted = { ...definition, start: (state: State, input: { id: string }, ctx: Parameters<NonNullable<typeof definition.start>>[2]) => {
      const handle = ctx.actions.remote.ask(input.id).withData({}).onResponse(ctx.onResponse.done).onError(ctx.onError.failed);
      corrupt(handle);
      void state;
    } };
    const registration = registerSagaDefinition({ ...options, definition: corrupted });
    await expect(registration.executeStart({ id: 'ok' }, metadata, origin, clock)).rejects.toBeInstanceOf(SagaStartDecisionError);
  }
  await expect(register().executeStart({ id: 'emit' }, { ...metadata, causationId: 'wrong' }, origin, clock)).rejects.toBeInstanceOf(SagaStartDecisionError);
});

it('allows only explicitly declared canonical core dispatch commands', async () => {
  const aggregate = { aggregateType: 'order', pure: { eventProjectors: {} }, commandCreators: {
    issue: (id: string) => ({ type: 'order.issue.command' as const, payload: { id } })
  } };
  const dispatching = createSaga({ identity: { namespace: 'orders', name: 'dispatching', version: 1 } })
    .initialState(() => ({ count: 0 }))
    .start<{ id: string }>((state, input, ctx) => {
      state.count++;
      ctx.actions.core.dispatch(aggregate, input.id).issue(input.id);
    }).correlateBy((input) => input.id).build();
  const opts = { definition: dispatching, pluginManifests: [] as const, responseHandlerBindings: {}, parseStartInput };
  const dispatchedOrigin = { ...origin, sagaKey: dispatching.sagaKey };
  const dispatchedMetadata = { ...metadata, sagaId: deriveSagaInstanceId(dispatchedOrigin.sagaKey, origin.correlation) };
  const allowed = registerSagaDefinition({ ...opts, canonicalCommandTypes: ['order.issue.command'] });
  expect((await allowed.executeStart({ id: 'ok' }, dispatchedMetadata, dispatchedOrigin, clock)).intents[0]).toMatchObject({ kind: 'dispatch', command: 'order.issue.command' });
  const denied = registerSagaDefinition({ ...opts, canonicalCommandTypes: [] });
  await expect(denied.executeStart({ id: 'ok' }, dispatchedMetadata, dispatchedOrigin, clock)).rejects.toBeInstanceOf(SagaStartDecisionError);
  expect(allowed.definitionIdentity.policySha256).not.toBe(denied.definitionIdentity.policySha256);
});

it('does not expose an invalid one-way emission after a preceding valid action', async () => {
  const pluginOneWay = defineSagaPlugin({ plugin_key: 'output', actions: { send: defineOneWay((id: string) => ({ id })) } });
  const saga = createSaga({ identity: { namespace: 'orders', name: 'bad-one-way', version: 1 }, plugins: [pluginOneWay] as const })
    .initialState(() => ({ count: 0 }))
    .start<{ id: string }>((state, input, ctx) => {
      state.count++;
      ctx.actions.output.send(input.id);
      const invalid = ctx.actions.output.send(input.id);
      Object.defineProperty(invalid, 'execution_payload', { value: { invalid: () => undefined } });
    }).correlateBy((input) => input.id).build();
  const registration = registerSagaDefinition({ definition: saga, pluginManifests: [pluginOneWay] as const,
    responseHandlerBindings: {}, parseStartInput, canonicalCommandTypes: [] });
  const turn = { ...origin, sagaKey: saga.sagaKey };
  const meta = { ...metadata, sagaId: deriveSagaInstanceId(saga.sagaKey, origin.correlation) };
  await expect(registration.executeStart({ id: 'ok' }, meta, turn, clock)).rejects.toBeInstanceOf(SagaStartDecisionError);
});
