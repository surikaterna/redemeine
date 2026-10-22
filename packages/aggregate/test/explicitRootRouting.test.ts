import { createAggregate, createEntity, createMixin, namingStrategies } from '../src';
import type { Event } from '@redemeine/kernel';
import { applyEvent, applyEventToDraft } from '../src/applyEvent';

const wire = 'payment_attempt.identifier.registered.event';
const payload = { id: 'same', key: 'same' };
const event = { type: wire, payload };
const initial = () => ({ count: 0, identifiers: [{ id: 'same', count: 0 }] });

test.each(['apply', 'applyToDraft'] as const)('%s routes explicit root names before core handlers or traversal', (method) => {
  const state = initial();
  const aggregate = createAggregate('payment_attempt', state).events({
    identifierRegistered(draft) { draft.count += 1; },
    registered(draft) { draft.count += 100; }
  }).overrideEventNames({ identifierRegistered: wire }).commands(emit => ({
    register: (_state, value: typeof payload) => emit.identifierRegistered(value)
  })).overrideCommandNames({ register: 'legacy.register.command' }).build();
  expect(aggregate.commandCreators.register(payload).type).toBe('legacy.register.command');
  expect(aggregate.process(state, aggregate.commandCreators.register(payload))[0].type).toBe(wire);
  expect(aggregate.types.events.identifierRegistered).toBe(wire);
  const result = method === 'apply' ? aggregate.apply(state, event) : state;
  if (method === 'applyToDraft') aggregate.applyToDraft(state, event);
  expect(result.count).toBe(1);
  expect(result.identifiers[0].count).toBe(0);
  if (method === 'apply') expect(state).toEqual(initial());
});

test('explicit root map-like path does not select a matching entry', () => {
  const state = { count: 0, identifiers: { same: { count: 0 } } };
  const aggregate = createAggregate('payment_attempt', state).events({
    identifierRegistered(draft) { draft.count++; }
  }).overrideEventNames({ identifierRegistered: wire }).build();
  expect(aggregate.apply(state, event)).toEqual({ ...state, count: 1 });
  aggregate.applyToDraft(state, event);
  expect(state).toEqual({ count: 1, identifiers: { same: { count: 0 } } });
});

const entity = () => createEntity<{ id: string; count: number }, 'identifier'>('identifier').events({
  identifierRegistered(draft) { draft.count += 10; }
}).commands(() => ({})).build();

test.each(['apply', 'applyToDraft'] as const)('%s preserves no-mixin root projectors across repeated builds', (method) => {
  const builder = createAggregate('payment_attempt', initial()).events({
    identifierRegistered(draft) { draft.count++; }
  }).overrideEventNames({ identifierRegistered: wire }).entityList('identifiers', entity(), undefined, {
    eventNameOverrides: { identifierRegistered: 'payment_attempt.identifier.entity_registered.event' }
  });
  const rootProjector = builder._state.events.identifierRegistered;
  const first = builder.build();
  const second = builder.build();
  const results = [first, second, first].map(aggregate => {
    const state = initial();
    if (method === 'apply') return aggregate.apply(state, event);
    aggregate.applyToDraft(state, event);
    return state;
  });
  expect(results).toEqual(Array.from({ length: 3 }, () => ({
    count: 1, identifiers: [{ id: 'same', count: 0 }]
  })));
  expect(builder._state.events.identifierRegistered).toBe(rootProjector);
});

test.each(['apply', 'applyToDraft'] as const)('%s captures mixin projectors before entity keys overwrite general maps', (method) => {
  const state = initial();
  const mixin = createMixin<typeof state>().events({
    identifierRegistered(draft) { draft.count++; }
  }).overrideEventNames({ identifierRegistered: wire }).build();
  const aggregate = createAggregate('payment_attempt', state).mixins(mixin).entityList('identifiers', entity()).build();
  const result = method === 'apply' ? aggregate.apply(state, event) : state;
  if (method === 'applyToDraft') aggregate.applyToDraft(state, event);
  expect(result.count).toBe(1);
  expect(result.identifiers[0].count).toBe(0);
});

test.each(['apply', 'applyToDraft'] as const)('%s gives an exact mounted full type priority over a root override', (method) => {
  const state = initial();
  const aggregate = createAggregate('payment_attempt', state).events({
    identifierRegistered(draft) { draft.count++; }
  }).overrideEventNames({ identifierRegistered: wire }).entityList('identifiers', entity(), undefined, {
    eventNameOverrides: { identifierRegistered: wire }
  }).build();
  const result = method === 'apply' ? aggregate.apply(state, event) : state;
  if (method === 'applyToDraft') aggregate.applyToDraft(state, event);
  expect(result.count).toBe(0);
  expect(result.identifiers[0].count).toBe(10);
});

test('generated targeted names retain legacy core-handler and entity traversal behavior', () => {
  const state = initial();
  const aggregate = createAggregate('payment_attempt', state).naming(namingStrategies.targeted).events({
    identifierRegistered(draft) { draft.count++; },
    registered(draft) { draft.count += 100; }
  }).build();
  expect(aggregate.types.events.identifierRegistered).toBe(wire);
  expect(aggregate.apply(state, event).identifiers[0].count).toBe(100);
  aggregate.applyToDraft(state, event);
  expect(state.identifiers[0].count).toBe(100);
  expect(state.count).toBe(0);
});

test.each(['apply', 'applyToDraft'] as const)('%s rejects asynchronous explicit root projectors', (method) => {
  const state = initial();
  const aggregate = createAggregate('payment_attempt', state).events({
    async identifierRegistered(_draft, _event: Event) {}
  }).overrideEventNames({ identifierRegistered: wire }).build();
  expect(() => aggregate[method](state, event)).toThrow(/synchronous/);
});

test.each(['apply', 'applyToDraft'] as const)('%s retains mounted map routing and naming overrides', (method) => {
  const state = { count: 0, identifiers: { same: { id: 'same', count: 0 } } };
  const aggregate = createAggregate('payment_attempt', state).entityMap('identifiers', entity(), {
    knownKeys: ['same'] as const
  }, { eventNameOverrides: { identifierRegistered: wire } }).build();
  const result = method === 'apply' ? aggregate.apply(state, event) : state;
  if (method === 'applyToDraft') aggregate.applyToDraft(state, event);
  expect(result.count).toBe(0);
  expect(result.identifiers.same.count).toBe(10);
});

test('exported positional apply calls retain legacy nested targeted routing without the new map', () => {
  const state = { identifiers: [{ id: 'same', details: { same: { count: 0 } } }] };
  const nested = { type: 'payment_attempt.identifier.detail.registered.event', payload };
  const projectors = { registered: (draft: { count: number }) => { draft.count++; } };
  const types = { 'payment_attempt.registered.event': projectors.registered };
  const unmatched = jest.fn();
  const result = applyEvent('payment_attempt', state, nested, projectors, {}, types, {}, {}, unmatched);
  expect(result.identifiers[0].details.same.count).toBe(1);
  expect(state.identifiers[0].details.same.count).toBe(0);
  applyEventToDraft('payment_attempt', state, nested, projectors, {}, types, {}, {}, unmatched);
  expect(state.identifiers[0].details.same.count).toBe(1);
  expect(unmatched).not.toHaveBeenCalled();
});
