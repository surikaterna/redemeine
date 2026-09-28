import { createAggregate } from '@redemeine/aggregate';
import { createSaga, defineOneWay, defineRequestResponse, defineSagaPlugin } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, processSagaSourceEvent, registerSagaDefinition } from '../src/index';
import { FakeTurnRepository, parseTurnEvent, parseTurnInput, parseTurnState, sourceEvent, orders } from './fixtures/turn-processor.fixture';

const outbound = defineSagaPlugin({ plugin_key: 'outbound', version: '1', actions: {
  send: defineOneWay((id: string) => ({ id })), ask: defineRequestResponse((id: string) => ({ id }))
} });
const invoice = createAggregate('invoice', { id: 'a1' })
  .commands(() => ({ pay: (_state, id: string) => ({ type: 'unused', payload: { id } }) })).build();
const billing = createAggregate('billing', { id: 'a1' })
  .commands(() => ({ pay: (_state, id: string) => ({ type: 'unused', payload: { id } }) }))
  .overrideCommandNames({ pay: 'billing.charge.command' }).build();
const bindings = { done: { phase: 'response' }, failed: { phase: 'error' }, again: { phase: 'retry' } } as const;

function setup(onData: null | object | undefined, invalid: 'start' | 'on' | null = null) {
  const definition = createSaga({ identity: { namespace: 'turns', name: 'mixed-intents', version: 1 }, plugins: [outbound] as const })
    .initialState(() => ({ count: 0 }))
    .onResponses({ done: () => undefined }).onErrors({ failed: () => undefined }).onRetries({ again: () => undefined })
    .start<{ orderId: string }>((state, input, ctx) => {
      state.count = 1;
      ctx.actions.outbound.send(input.orderId);
      ctx.actions.outbound.ask(input.orderId).withData(null).onResponse(ctx.onResponse.done).onRetry(ctx.onRetry.again).onError(ctx.onError.failed);
      ctx.commandsFor(invoice, 'a1').pay('a1');
      ctx.commandsFor(billing, 'a1').pay('a1');
      ctx.schedule('start-timer', 10);
      ctx.cancelSchedule('start-timer');
      if (invalid === 'start') ctx.schedule('bad-last', -1);
    })
    .correlateBy(input => input.orderId)
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(orders, event => event.payload.orderId)
    .on(orders, { paid: (state, _event, ctx) => {
      state.count += 1;
      const request = ctx.actions.outbound.ask('on');
      const routed = onData === undefined ? request : request.withData(onData);
      routed.onResponse(ctx.onResponse.done).onRetry(ctx.onRetry.again).onError(ctx.onError.failed);
      ctx.actions.outbound.send('on');
      ctx.commandsFor(invoice, 'a1').pay('a1');
      ctx.commandsFor(billing, 'a1').pay('a1');
      ctx.schedule('on-timer', 20);
      ctx.cancelSchedule('on-timer');
      if (invalid === 'on') ctx.schedule('bad-last', -1);
    } }).build();
  const registration = registerSagaDefinition({ definition, pluginManifests: [outbound] as const,
    responseHandlerBindings: bindings, parseStartInput: parseTurnInput, parseState: parseTurnState,
    parseOnEvent: parseTurnEvent, canonicalCommandTypes: ['invoice.pay.command', 'billing.charge.command'] });
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }]);
  const options = { registrationForRoute: bindSagaRegistrations(table, [registration]) };
  return { table, options };
}

function material(repository: FakeTurnRepository, index: number) {
  const events = repository.appendCalls[index]?.events;
  if (!events) throw new Error('missing turn');
  return events.map(event => event.payload);
}

it.each([undefined, null, { source: 'on' }])('commits full ordered mixed start/on turns with on data %p and reconciles duplicates', async data => {
  const { table, options } = setup(data);
  const repository = new FakeTurnRepository();
  const first = sourceEvent();
  const second = sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'source-on', eventId: 'event-on' });
  await expect(processSagaSourceEvent(table, repository, first, options)).resolves.toMatchObject([{ status: 'committed' }]);
  await expect(processSagaSourceEvent(table, repository, second, options)).resolves.toMatchObject([{ status: 'committed' }]);
  expect(repository.appendCalls).toHaveLength(2);
  for (const [index, count, timer, due] of [[0, 4, 'start-timer', '2026-09-21T10:00:00.010Z'],
    [1, 2, 'on-timer', '2026-09-21T10:00:00.020Z']] as const) {
    const events = repository.appendCalls[index]!.events;
    expect(events.map(event => event.type)).toEqual([
      ...Array.from({ length: count }, (_, position) => index === 0
        ? ['saga.instance_created.event', 'saga.definition_identity_recorded.event', 'saga.source_event_observed.event', 'saga.business_state_recorded.event'][position]
        : ['saga.source_event_observed.event', 'saga.business_state_recorded.event'][position]),
      ...Array(6).fill('saga.intent_recorded.event').flatMap((type, position) => position >= 4 ? [type, 'saga.timer_fact_recorded.event'] : [type])
    ]);
    const intents = events.filter(event => event.type === 'saga.intent_recorded.event').map(event => {
      const payload = event.payload;
      if (typeof payload !== 'object' || payload === null || !('intent' in payload)) throw new Error('missing intent');
      return payload.intent;
    });
    expect(intents).toMatchObject(index === 0 ? [
      { kind: 'plugin', interaction: 'fire_and_forget' }, { kind: 'plugin', interaction: 'request_response' },
      { kind: 'dispatch', command: 'invoice.pay.command' }, { kind: 'dispatch', command: 'billing.charge.command' },
      { kind: 'schedule', timerId: timer, dueAt: due }, { kind: 'cancelSchedule', timerId: timer }
    ] : [
      { kind: 'plugin', interaction: 'request_response' }, { kind: 'plugin', interaction: 'fire_and_forget' },
      { kind: 'dispatch', command: 'invoice.pay.command' }, { kind: 'dispatch', command: 'billing.charge.command' },
      { kind: 'schedule', timerId: timer, dueAt: due }, { kind: 'cancelSchedule', timerId: timer }
    ]);
    expect(intents.map(intent => intent.origin.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(intents.map(intent => intent.intentId)).size).toBe(6);
    expect(intents[ index === 0 ? 1 : 0 ].routing_metadata).toMatchObject({ response_handler_key: 'done', error_handler_key: 'failed', retry_handler_key: 'again' });
    const routing = intents[index === 0 ? 1 : 0].routing_metadata;
    expect(Object.hasOwn(routing, 'handler_data')).toBe(index === 0 || data !== undefined);
    if (index === 0) expect(routing.handler_data).toBeNull();
    else if (data !== undefined) expect(routing.handler_data).toEqual(data);
  }
  const expected = [material(repository, 0), material(repository, 1)];
  await expect(processSagaSourceEvent(table, repository, first, options)).resolves.toMatchObject([{ status: 'reconciled' }]);
  await expect(processSagaSourceEvent(table, repository, second, options)).resolves.toMatchObject([{ status: 'reconciled' }]);
  expect(repository.appendCalls).toHaveLength(2);
  expect([material(repository, 0), material(repository, 1)]).toEqual(expected);
});

it.each(['start', 'on'] as const)('rejects the final invalid %s intent without a partial append', async invalid => {
  const { table, options } = setup(undefined, invalid);
  const repository = new FakeTurnRepository();
  if (invalid === 'on') await processSagaSourceEvent(table, repository, sourceEvent(), options);
  const before = repository.appendCalls.length;
  const source = invalid === 'on' ? sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'source-on' }) : sourceEvent();
  await expect(processSagaSourceEvent(table, repository, source, options))
    .rejects.toMatchObject({ code: invalid === 'on' ? 'invalid_on_intent' : 'start_failed', retryable: false });
  expect(repository.appendCalls).toHaveLength(before);
});

it('refuses a duplicate when recomputed on intent material differs at the original prefix', async () => {
  const data = { source: 'original' };
  const { table, options } = setup(data);
  const repository = new FakeTurnRepository();
  await processSagaSourceEvent(table, repository, sourceEvent(), options);
  const on = sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'source-on' });
  await processSagaSourceEvent(table, repository, on, options);
  data.source = 'changed';
  await expect(processSagaSourceEvent(table, repository, on, options))
    .rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
  expect(repository.appendCalls).toHaveLength(2);
});
