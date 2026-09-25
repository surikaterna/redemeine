import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, compileSagaRoutes, matchSagaRoutes,
  registerSagaDefinition, deriveSagaInstanceId, serializeSagaCorrelation } from '../src/index';

interface OrderState { orderId: string; count: number }
interface OtherState { label: string }

const orders = createAggregate('registered-orders', { count: 0 }).events({
  placed: (state, _event: Event<{ orderId: string }>) => { state.count++; }
}).overrideEventNames({ placed: 'registered.placed' }).build();

function orderId(value: unknown): string {
  if (!value || typeof value !== 'object' || !('orderId' in value) || typeof value.orderId !== 'string') {
    throw new TypeError('Invalid order ID');
  }
  return value.orderId;
}

const first = createSaga<OrderState>({ identity: { namespace: 'registered', name: 'first', version: 1 } })
  .initialState(() => ({ orderId: '', count: 0 }))
  .start((state, input: { orderId: string }) => { state.orderId = input.orderId; })
  .correlateBy((input) => input.orderId)
  .triggeredBy({ kind: 'event', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
  .correlate(orders, (event) => orderId(event.payload))
  .on(orders, { placed: (state) => { state.count++; } }).build();
const second = createSaga<OtherState>({ identity: { namespace: 'registered', name: 'second', version: 1 } })
  .initialState(() => ({ label: '' }))
  .start((state, input: { orderId: string }) => { state.label = input.orderId; })
  .correlateBy((input) => input.orderId)
  .triggeredBy({ kind: 'event', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
  .correlate(orders, (event) => orderId(event.payload))
  .on(orders, { placed: (state, event) => { state.label = event.payload.orderId; } }).build();

function parseEvent(value: unknown) {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'registered.placed' ||
      !('payload' in value)) throw new TypeError('Invalid event');
  orderId(value.payload);
  return { type: value.type, payload: value.payload };
}

const registration = registerSagaDefinition({ definition: first, pluginManifests: [] as const,
  responseHandlerBindings: {}, canonicalCommandTypes: [], parseStartInput: (value: unknown) => ({ orderId: orderId(value) }),
  parseState: (value: unknown): OrderState => {
    if (!value || typeof value !== 'object' || !('count' in value) || typeof value.count !== 'number') throw new TypeError('Invalid state');
    return { orderId: orderId(value), count: value.count };
  }, parseOnEvent: parseEvent });
const other = registerSagaDefinition({ definition: second, pluginManifests: [] as const,
  responseHandlerBindings: {}, canonicalCommandTypes: [], parseStartInput: (value: unknown) => ({ orderId: orderId(value) }),
  parseState: (value: unknown): OtherState => {
    if (!value || typeof value !== 'object' || !('label' in value) || typeof value.label !== 'string') throw new TypeError('Invalid state');
    return { label: value.label };
  }, parseOnEvent: parseEvent });
const origin = { sagaKey: first.sagaKey, correlation: { type: 'string' as const, value: 'o' }, sourceId: 'e', routeId: 'r' };
const metadata = { sagaId: deriveSagaInstanceId(first.sagaKey, origin.correlation),
  correlationId: serializeSagaCorrelation(origin.correlation), causationId: 'e' };
const source = { type: 'registered.placed', payload: { orderId: 'o' }, partitionId: 'p', streamId: 's',
  commitId: 'c', eventIndex: 0, eventId: 'e' };

it('compiles heterogeneous typed handles with matching legacy route IDs and correlation', () => {
  const table = compileRegisteredSagaRoutes([registration, other], [
    { registration, triggerIndex: 0, eventTypes: ['registered.placed'] },
    { registration: other, triggerIndex: 0, eventTypes: ['registered.placed'] }
  ]);
  const legacy = compileSagaRoutes([first], [{ definition: first, triggerIndex: 0, eventTypes: ['registered.placed'] }]);
  expect(table.routes.filter((route) => route.sagaKey === first.sagaKey).map((route) => route.routeId))
    .toEqual(legacy.routes.map((route) => route.routeId));
  expect(matchSagaRoutes(table, source)).toHaveLength(4);
  const resolve = bindSagaRegistrations(table, [registration, other]);
  for (const route of table.routes) expect(resolve(route).definition).toBe(route.definition);
  expect(() => bindSagaRegistrations(table, [registration])).toThrow('Missing');
  expect(() => bindSagaRegistrations(table, [registration, registerSagaDefinition({ definition: second,
    pluginManifests: [] as const, responseHandlerBindings: {}, canonicalCommandTypes: [],
    parseStartInput: (value: unknown) => ({ orderId: orderId(value) }) })])).toThrow('Mismatched');
  expect(() => compileRegisteredSagaRoutes([{ ...registration }])).toThrow('Untrusted');
  expect(() => compileRegisteredSagaRoutes([registration], [{ registration: other, triggerIndex: 0, eventTypes: ['registered.placed'] }])).toThrow();
});

it('decodes start, state and event before invoking typed handlers', async () => {
  await expect(registration.executeStart({}, metadata, origin, '2026-09-25T00:00:00.000Z')).rejects.toThrow('Invalid order ID');
  const result = await registration.executeStart({ orderId: 'o' }, metadata, origin, '2026-09-25T00:00:00.000Z');
  expect(result.state).toEqual({ orderId: 'o', count: 0 });
  expect(result.intents).toEqual([]);
  await expect(registration.executeOn({ orderId: 'o' }, parseEvent(source), metadata, 'placed')).rejects.toThrow('Invalid state');
  await expect(registration.executeOn(result.state, { type: 'registered.placed', payload: {} }, metadata, 'placed')).rejects.toThrow('Invalid order ID');
  expect(await registration.executeOn(result.state, parseEvent(source), metadata, 'placed'))
    .toEqual({ state: { orderId: 'o', count: 1 }, intents: [] });
});
