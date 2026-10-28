import { createAggregate, createEntity, createMixin } from '../src';
import type { Event } from '@redemeine/kernel';
import { produce } from 'immer';
import { definitionTargets } from '../src/build/entityCommandTarget';

type Row = { id: string; count: number };
const initial = () => ({ count: 10, identifiers: [{ id: 'a', count: 2 }], others: [{ id: 'a', count: 7 }] });
type State = ReturnType<typeof initial>;
const rootProjector = (state: State, event: Event<Row>) => { state.count = event.payload.count; };
const childProjector = (state: Row, event: Event<Row>) => { state.count = event.payload.count; };
const rootEvents = { registered: { projector: rootProjector, meta: { owner: 'root' } } };

function entity(projector = childProjector) {
  return createEntity<Row, 'identifier'>('identifier').events({
    registered: { projector, meta: { owner: 'entity' } }
  }).commands(emit => ({ register(state, payload: { id: string }) {
    expect(() => Reflect.set(state, 'count', 999)).toThrow();
    return emit.registered({ ...payload, count: state.count + 1 });
  } })).build();
}

function rootCommands() {
  return (emit: { registered: (payload: Row) => Event<Row> }) => ({
    register(state: State, payload: { id: string }) {
      return emit.registered({ ...payload, count: state.count + 1 });
    }
  });
}

type ReplayHost = {
  apply(state: State, event: Event): unknown;
  applyToDraft(state: State, event: Event): void;
};

function expectReplay(host: ReplayHost, event: Event, expected: State) {
  const before = initial();
  expect(host.apply(before, event)).toEqual(expected);
  expect(produce(before, draft => host.applyToDraft(draft, event))).toEqual(expected);
  expect(before).toEqual(initial());
}

test.each(['before', 'after', 'mixin'] as const)('root ownership survives %s registration and repeated builds', order => {
  const base = createAggregate('payment_attempt', initial());
  const mixin = createMixin<State>().events(rootEvents).build();
  const builder = order === 'before' ? base.events(rootEvents).entityList('identifiers', entity())
    : order === 'after' ? base.entityList('identifiers', entity()).events(rootEvents)
      : base.mixins(mixin).entityList('identifiers', entity());
  const ready = builder.commands(rootCommands());
  for (const host of [ready.build(), ready.build()]) {
    expect(host.pure.eventProjectors.registered).toBe(rootProjector);
    expect(definitionTargets(host.pure.eventProjectors).registered ?? []).toEqual([]);
    const root = host.process(initial(), host.commandCreators.register({ id: 'a' }))[0]!;
    expect(root.type).toBe('payment_attempt.registered.event');
    expect(host.metadata.events[root.type].meta).toEqual({ owner: 'root' });
    expectReplay(host, root, { ...initial(), count: 11 });
    const child = host.process(initial(), host.commandCreators.identifiersRegister({ id: 'a' }))[0]!;
    expect(child.type).toBe('payment_attempt.identifiers.registered.event');
    expect(child.payload).toEqual({ id: 'a', count: 3 });
    expect(host.metadata.events[child.type].meta).toEqual({ owner: 'entity' });
    expectReplay(host, child, { ...initial(), identifiers: [{ id: 'a', count: 3 }] });
  }
});

test('root and two scoped definitions with one JS key retain independent handlers and targets', () => {
  const otherProjector = (state: Row, event: Event<Row>) => { state.count = event.payload.count + 100; };
  const host = createAggregate('payment_attempt', initial()).events(rootEvents)
    .entityList('identifiers', entity()).entityList('others', entity(otherProjector)).build();
  expect(host.pure.eventProjectors.registered).toBe(rootProjector);
  expectReplay(host, { type: 'payment_attempt.registered.event', payload: { id: 'a', count: 11 } }, { ...initial(), count: 11 });
  expectReplay(host, { type: 'payment_attempt.identifiers.registered.event', payload: { id: 'a', count: 3 } },
    { ...initial(), identifiers: [{ id: 'a', count: 3 }] });
  expectReplay(host, { type: 'payment_attempt.others.registered.event', payload: { id: 'a', count: 8 } },
    { ...initial(), others: [{ id: 'a', count: 108 }] });
});

test('entity-only reflection keys do not declare synthetic root wires', () => {
  const last = (state: Row, event: Event<Row>) => { state.count = event.payload.count + 100; };
  const unmatched = jest.fn();
  const host = createAggregate('payment_attempt', initial()).entityList('identifiers', entity())
    .entityList('others', entity(last)).onUnmatchedEvent(unmatched).build();
  expect(host.pure.eventProjectors.registered).toBe(last);
  expect(definitionTargets(host.pure.eventProjectors).registered?.[0]?.statePath).toEqual(['others']);
  expectReplay(host, { type: 'payment_attempt.others.registered.event', payload: { id: 'a', count: 8 } },
    { ...initial(), others: [{ id: 'a', count: 108 }] });
  expectReplay(host, { type: 'payment_attempt.registered.event', payload: { id: 'a', count: 8 } }, initial());
  expect(unmatched).toHaveBeenCalledTimes(2);
});

test('flattened mixin entity provenance is not protected as root ownership', () => {
  const source = createMixin<State>().entityList('identifiers', entity()).build();
  const last = (state: Row, event: Event<Row>) => { state.count = event.payload.count + 100; };
  const builder = createAggregate('payment_attempt', initial()).mixins({ ...source, mountedEntities: [] })
    .entityList('others', createEntity<Row, 'other'>('other').events({ identifiersRegistered: last }).build());
  for (const host of [builder.build(), builder.build()]) {
    expect(host.pure.eventProjectors.identifiersRegistered).toBe(last);
    expect(definitionTargets(host.pure.eventProjectors).identifiersRegistered?.[0]?.statePath).toEqual(['others']);
    expectReplay(host, { type: 'payment_attempt.others.identifiers_registered.event', payload: { id: 'a', count: 8 } },
      { ...initial(), others: [{ id: 'a', count: 108 }] });
    expectReplay(host, { type: 'payment_attempt.identifiers_registered.event', payload: { id: 'a', count: 8 } },
      { ...initial(), identifiers: [{ id: 'a', count: 8 }] });
  }
});

test('an exact scoped full-wire collision still beats the explicit root override', () => {
  const wire = 'payment_attempt.identifiers.registered.event';
  const host = createAggregate('payment_attempt', initial()).events(rootEvents)
    .overrideEventNames({ registered: wire }).entityList('identifiers', entity()).build();
  expect(host.pure.eventProjectors.registered).toBe(rootProjector);
  expectReplay(host, { type: wire, payload: { id: 'a', count: 3 } },
    { ...initial(), identifiers: [{ id: 'a', count: 3 }] });
});
