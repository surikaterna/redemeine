import { createAggregate } from '@redemeine/aggregate';
import { createSaga, defineOneWay, defineRequestResponse, defineSagaPlugin } from '@redemeine/saga';
import { compileRegisteredSagaRoutes, registerSagaDefinition } from '@redemeine/saga-runtime';
import { orderIdFrom, parseRealEvent, realOrders } from './fixtures';

const outbound = defineSagaPlugin({ plugin_key: 'outbound', version: '1', actions: {
  send: defineOneWay((id: string) => ({ id })), ask: defineRequestResponse((id: string) => ({ id }))
} });
const invoice = createAggregate('invoice', { id: 'a1' })
  .commands(() => ({ pay: (_state, id: string) => ({ type: 'unused', payload: { id } }) })).build();
const billing = createAggregate('billing', { id: 'a1' })
  .commands(() => ({ pay: (_state, id: string) => ({ type: 'unused', payload: { id } }) }))
  .overrideCommandNames({ pay: 'billing.charge.command' }).build();
type Mode = 'normal' | 'invalid-start' | 'invalid-on';

function state(value: unknown): { count: number } {
  if (typeof value !== 'object' || value === null || !('count' in value) || typeof value.count !== 'number') {
    throw new TypeError('invalid state');
  }
  return { count: value.count };
}

function input(value: unknown): { orderId: string } {
  if (typeof value !== 'object' || value === null || !('orderId' in value) || typeof value.orderId !== 'string') {
    throw new TypeError('invalid input');
  }
  return { orderId: value.orderId };
}

export function createIntentTable(name: string, mode: Mode = 'normal', handlerData?: { tag: string } | null) {
  const definition = createSaga({ identity: { namespace: 'real.stack', name, version: 1 }, plugins: [outbound] as const })
    .initialState(() => ({ count: 0 }))
    .onResponses({ done: () => undefined }).onErrors({ failed: () => undefined }).onRetries({ again: () => undefined })
    .start<{ orderId: string }>((value, start, ctx) => {
      value.count = 1;
      ctx.actions.outbound.send(start.orderId);
      const request = ctx.actions.outbound.ask(start.orderId);
      const routed = handlerData === undefined ? request : request.withData(handlerData);
      routed.onResponse(ctx.onResponse.done).onRetry(ctx.onRetry.again).onError(ctx.onError.failed);
      ctx.commandsFor(invoice, 'a1').pay('a1');
      ctx.commandsFor(billing, 'a1').pay('a1');
      ctx.schedule('start-timer', 10);
      ctx.cancelSchedule('start-timer');
      if (mode === 'invalid-start') ctx.schedule('bad-last', -1);
    })
    .correlateBy(start => start.orderId)
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(realOrders, event => orderIdFrom(event))
    .on(realOrders, { paid: (value, _event, ctx) => {
      value.count += 1;
      const request = ctx.actions.outbound.ask('on');
      const routed = handlerData === undefined ? request : request.withData(handlerData);
      routed.onResponse(ctx.onResponse.done).onRetry(ctx.onRetry.again).onError(ctx.onError.failed);
      ctx.actions.outbound.send('on');
      ctx.commandsFor(invoice, 'a1').pay('a1');
      ctx.commandsFor(billing, 'a1').pay('a1');
      ctx.schedule('on-timer', 20);
      ctx.cancelSchedule('on-timer');
      if (mode === 'invalid-on') ctx.schedule('bad-last', -1);
    } }).build();
  const registration = registerSagaDefinition({ definition, pluginManifests: [outbound] as const,
    responseHandlerBindings: { done: { phase: 'response' }, failed: { phase: 'error' }, again: { phase: 'retry' } },
    parseStartInput: input, parseState: state,
    parseOnEvent: parseRealEvent, canonicalCommandTypes: ['invoice.pay.command', 'billing.charge.command'] });
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }]);
  return { definition, table };
}
