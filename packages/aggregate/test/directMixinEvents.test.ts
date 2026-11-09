import { createAggregate, createEntity, createMixin, schemaBindings } from '../src';
import type { Event } from '../../kernel/src';

const first = createMixin<{ count: number }>().events({
  audited: (state, event: Event<{ count: number }>) => { state.count = event.payload.count; },
}).build();
const last = createMixin<{ count: number }>().events({
  counted: (state, event: Event<{ count: number }>) => { state.count = event.payload.count + 1; },
}).build();

test('ordered mixins, multiple calls, inheritance and repeated builds retain distinct aliases', () => {
  const parent = createAggregate('parent', { count: 0 }).mixins(first);
  const builders = [createAggregate('host', { count: 0 }).mixins(first, last),
    createAggregate('host', { count: 0 }).mixins(first).mixins(last),
    createAggregate('host', { count: 0 }).extends(parent).mixins(last)];
  for (const builder of builders) {
    for (let i = 0; i < 2; i++) {
      const built = builder.build();
      expect(schemaBindings(built).events.wireToSchema).toEqual({
        'host.audited.event': 'audited', 'host.counted.event': 'counted',
      });
      expect(built.apply({ count: 0 }, { type: 'host.counted.event', payload: { count: 2 } })).toEqual({ count: 3 });
      expect(Object.hasOwn(built, '__mixinEventDeclarationsType')).toBe(false);
      expect(Object.keys(built.eventCreators)).toEqual([]);
    }
  }
});

test('shared wires keep all forward aliases and the actual compiled winner without recomputing names', () => {
  let calls = 0;
  const built = createAggregate('host', { count: 0 }).mixins(first, last)
    .naming({ event: () => { calls++; return 'shared'; } }).build();
  const before = calls;
  const bindings = schemaBindings(built);
  expect(calls).toBe(before);
  expect(bindings.events.wireToSchema).toEqual({ shared: 'counted' });
  expect(bindings.events.schemaToWire.audited).toEqual({ wireType: 'shared', winnerSchemaId: 'counted', isWireWinner: false });
  expect(built.apply({ count: 0 }, { type: 'shared', payload: { count: 2 } })).toEqual({ count: 3 });
});

test('duplicate direct declarations reject the accessor without changing the winning dispatch', () => {
  const duplicate = createMixin<{ count: number }>().events({
    audited: (state, _event: Event<{}>) => { state.count = 99; },
  }).build();
  for (const built of [createAggregate('host', { count: 0 }).mixins(first, duplicate).build(),
    createAggregate('host', { count: 0 }).events({ audited: () => {} }).mixins(duplicate).build(),
    createAggregate('host', { count: 0 }).mixins(duplicate, duplicate).build()]) {
    expect(() => schemaBindings(built)).toThrow(/Ambiguous.*audited/);
    expect(built.apply({ count: 0 }, { type: 'host.audited.event', payload: {} })).toEqual({ count: 99 });
  }
});

test('flattening preserves distinct aliases, while copying a component does not invent collisions', () => {
  const row = createEntity('row', { id: '', value: 0 }).events({ changed: () => {} }).build();
  const mixin = createMixin<{}>().events({ rowsChanged: () => {} }).entityMap('rows', row).build();
  expect(Object.keys(schemaBindings(createAggregate('host', {}).mixins(mixin).build()).events.schemaToWire).sort())
    .toEqual(['rows.changed', 'rowsChanged']);
  expect(() => schemaBindings(createAggregate('host', {}).mixins(mixin, mixin).build())).toThrow(/Ambiguous/);
  const clean = createMixin<{}>().events({ direct: () => {} }).entityMap('rows', row).build();
  for (let i = 0; i < 2; i++) expect(Object.keys(schemaBindings(createAggregate('host', {}).mixins(clean).build())
    .events.schemaToWire).sort()).toEqual(['direct', 'rows.changed']);
});

test('dotted direct IDs collide with mounted IDs and structural runtime handlers remain supported', () => {
  const row = createEntity('row', {}).events({ changed: () => {} }).build();
  const built = createAggregate('host', {}).mixins(createMixin<{}>().events({ 'rows.changed': () => {} }).build())
    .entityMap('rows', row).build();
  expect(() => schemaBindings(built)).toThrow(/Ambiguous.*rows.changed/);
  const structural = createAggregate('host', {}).mixins({ projectors: { direct: () => {} } }).build();
  expect(schemaBindings(structural).events.wireToSchema).toEqual({ 'host.direct.event': 'direct' });
});

test.each([false, true])('own prototype-named events have string bindings and retain runtime dispatch (mixin=%s)', mixin => {
  const handlers = {
    ['__proto__']: (state: { count: number }, event: Event<{ count: number }>) => { state.count = event.payload.count; },
    constructor: (state: { count: number }, event: Event<{ count: number }>) => { state.count = event.payload.count + 1; },
    toString: (state: { count: number }, event: Event<{ count: number }>) => { state.count = event.payload.count + 2; },
  };
  const builder = createAggregate('host', { count: 0 });
  const built = (mixin ? builder.mixins(createMixin<{ count: number }>().events(handlers).build()) : builder.events(handlers)).build();
  const bindings = schemaBindings(built);
  expect(JSON.parse(JSON.stringify(bindings))).toEqual(bindings);
  for (const [id, wire, offset] of [['__proto__', 'host.__proto__.event', 0], ['constructor', 'host.constructor.event', 1],
    ['toString', 'host.to_string.event', 2]] as const) {
    const entry = bindings.events.schemaToWire[id]!;
    expect(entry).toEqual({ wireType: wire, winnerSchemaId: id, isWireWinner: true });
    expect(typeof entry.wireType).toBe('string');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(bindings.events.wireToSchema[wire]).toBe(id);
    expect(built.apply({ count: 0 }, { type: wire, payload: { count: 2 } })).toEqual({ count: 2 + offset });
  }
  const shared = (mixin ? createAggregate('host', { count: 0 }).mixins(createMixin<{ count: number }>().events(handlers).build())
    : createAggregate('host', { count: 0 }).events(handlers)).naming({ event: () => '__proto__' }).build();
  const aliases = schemaBindings(shared);
  expect(aliases.events.wireToSchema.__proto__).toBe('toString');
  for (const id of Object.keys(handlers)) expect(aliases.events.schemaToWire[id]).toEqual({
    wireType: '__proto__', winnerSchemaId: 'toString', isWireWinner: id === 'toString',
  });
  expect(shared.apply({ count: 0 }, { type: '__proto__', payload: { count: 2 } })).toEqual({ count: 4 });
});
