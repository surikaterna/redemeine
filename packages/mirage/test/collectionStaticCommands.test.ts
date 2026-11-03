import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, extractState, MirageCoreSymbol } from '../src';
import type { Event } from '@redemeine/kernel';

type Identifier = { domain: string; authority: string; identifier: string };
const template: Identifier = { domain: '', authority: '', identifier: '' };
function identifierEntity() {
  return createEntity('identifier', template).events({
    registered(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; },
    amended(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; }
  }).commands(emit => {
    const register = (state: Readonly<Identifier>, payload: Identifier, { isNew }: { isNew: boolean }) => {
      if (isNew) return emit.registered(payload);
      return state.identifier === payload.identifier ? [] : emit.amended(payload);
    };
    return { register, packed: { pack: (domain: string, authority: string, identifier: string) => ({ domain, authority, identifier }), handler: register },
      ignore: (_state: Readonly<Identifier>, _payload: Identifier) => [], ordinary: register };
  }, { static: ['register', 'packed', 'ignore'] }).build();
}
function identifierHost() {
  return createAggregate('registry', { identifiers: [] as Identifier[] })
    .entityList('identifiers', identifierEntity(), { pk: ['domain', 'authority'] }).build();
}

test('explicit shorthand and packed collection commands use full identity and return aggregate state', async () => {
  const live = createMirage(identifierHost(), 'root');
  const payload = { domain: 'example.org', authority: 'issuer', identifier: 'one' };
  expect(await live.identifiers.register(payload)).toEqual({ identifiers: [payload] });
  expect(await live.identifiers.register(payload)).toEqual({ identifiers: [payload] });
  expect(live[MirageCoreSymbol].version).toBe(1);
  expect(await live.identifiers.packed(payload.domain, payload.authority, 'two'))
    .toEqual({ identifiers: [{ ...payload, identifier: 'two' }] });
  expect(live[MirageCoreSymbol].getPendingResults().events.map(event => event.type))
    .toEqual(['registry.identifier.registered.event', 'registry.identifier.amended.event']);
  expect(await live.identifiers({ domain: payload.domain, authority: payload.authority }).register({ identifier: 'three' }))
    .toEqual({ ...payload, identifier: 'three' });
  expect([...live.identifiers][0]!.identifier).toBe('three');
  expect(live.identifiers.map(item => item.identifier)).toEqual(['three']);
  expect(() => Reflect.set(live.identifiers, '0', {})).toThrow();
  expect(Reflect.get(live.identifiers, 'ordinary')).toBeUndefined();
});

test('no-event missing calls do not insert; Aggregate rejects missing, invalid and ambiguous identity', () => {
  const host = identifierHost();
  const live = createMirage(host, 'empty');
  live.identifiers.ignore({ domain: 'd', authority: 'a', identifier: 'none' });
  expect(extractState(live)).toEqual({ identifiers: [] });
  for (const payload of [{ domain: 'd' }, { domain: 'd', authority: {} }]) {
    expect(() => Reflect.apply(live.identifiers.register, undefined, [payload])).toThrow('Invalid mounted command target');
  }
  const item = { domain: 'd', authority: 'a', identifier: 'one' };
  const duplicate = createMirage(host, 'duplicate', { snapshot: { identifiers: [item, item] } });
  expect(() => duplicate.identifiers.register(item)).toThrow('Invalid mounted command target');
});

test('presence controls isNew even when state equals template, without magic register exposure', () => {
  const seen: boolean[] = [];
  const entity = createEntity('row', { id: 'same' }).commands(() => ({
    check(_state, _payload: { id: string }, context) { seen.push(context.isNew); return []; }, register: () => []
  }), { static: ['check'] }).build();
  const host = createAggregate('presence', { rows: [] as { id: string }[] }).entityList('rows', entity).build();
  const missing = createMirage(host, 'missing');
  missing.rows.check({ id: 'same' });
  createMirage(host, 'present', { snapshot: { rows: [{ id: 'same' }] } }).rows.check({ id: 'same' });
  expect(seen).toEqual([true, false]);
  expect(missing.rows.length).toBe(0);
  expect(Reflect.get(missing.rows, 'register')).toBeUndefined();
});

test.each(['map', 'push', 'length', 'first', 'then', '0', '1.5'])('static namespace rejects %s even on empty lists', name => {
  const entity = createEntity('row', { id: '' }).commands(() => ({ [name]: () => [] }), { static: [name] }).build();
  const host = createAggregate('collision', { rows: [] as { id: string }[] }).entityList('rows', entity).build();
  expect(() => createMirage(host, 'root')).toThrow(/collision/);
});

test('ordinary array-named commands remain valid and maps do not expose statics', () => {
  const ordinary = createEntity('row', { id: '' }).commands(() => ({ map: () => [] })).build();
  const staticRow = createEntity('row', { id: '' }).commands(() => ({ register: () => [] }), { static: ['register'] }).build();
  const host = createAggregate('replace', { rows: [] as { id: string }[] })
    .entityList('rows', ordinary).build();
  expect(Reflect.get(createMirage(host, 'root').rows, 'register')).toBeUndefined();
  const mapped = createAggregate('mapped', { rows: { one: { id: 'one' } } }).entityMap('rows', staticRow).build();
  expect(Reflect.get(createMirage(mapped, 'map').rows, 'register')).toBeUndefined();
});

test('wire aliases remain callable and both dispatch full payloads and packs to the winning mount', async () => {
  const entity = identifierEntity();
  const host = createAggregate('shadowed', { left: [] as Identifier[], right: [] as Identifier[] })
    .entityList('left', entity, { pk: ['domain', 'authority'] }, { semanticName: 'leftIdentifier', commandNameOverrides: { register: 'shared', packed: 'packed' } })
    .entityList('right', entity, { pk: ['domain', 'authority'] }, { semanticName: 'rightIdentifier', commandNameOverrides: { register: 'shared', packed: 'packed' } }).build();
  const live = createMirage(host, 'root');
  const payload = { domain: 'd', authority: 'a', identifier: 'one' };
  expect(await live.left.register(payload)).toEqual({ left: [], right: [payload] });
  expect(await live.right.register(payload)).toEqual({ left: [], right: [payload] });
  const updated = { ...payload, identifier: 'two' };
  expect(await live.left.packed('d', 'a', 'two')).toEqual({ left: [], right: [updated] });
  expect(await live.right.packed('d', 'a', 'two')).toEqual({ left: [], right: [updated] });
  expect(live.left.length).toBe(0);
  expect(live.right.length).toBe(1);
});

test('different definitions at the same mount fail before static metadata can be overwritten', () => {
  const first = identifierEntity();
  const second = createEntity('readOnly', template).build();
  expect(() => createAggregate('invalid', { rows: [] as Identifier[] })
    .entityList('rows', first).entityList('rows', second).build()).toThrow(/rows.*identifier.*readOnly/);
  const host = createAggregate('reuse', { rows: [] as Identifier[] })
    .entityList('rows', first, { pk: ['domain', 'authority'] })
    .entityList('rows', first, { pk: ['domain', 'authority'] }).build();
  expect(typeof createMirage(host, 'root').rows.register).toBe('function');
});

test.each([true, false])('different authored names cannot flatten to one compiled key (static first: %s)', staticFirst => {
  const entity = createEntity('row', { id: '' }).commands(() => ({ register: () => [], Register: () => [] }),
    { static: staticFirst ? ['register'] : ['Register'] }).build();
  expect(() => createAggregate('ambiguous', { rows: [] as { id: string }[] })
    .entityList('rows', entity).build()).toThrow(/rows\.register.*rows\.Register.*rowsRegister/);
});

test('nested statics gain no parent aliases', () => {
  const parent = createEntity('parent', { id: '', children: [] as Identifier[] }).entityList('children', identifierEntity()).build();
  const host = createAggregate('nestedStatic', { parents: [{ id: 'p', children: [] as Identifier[] }] })
    .entityList('parents', parent).build();
  const live = createMirage(host, 'root');
  expect(Reflect.get(live.parents, 'childrenRegister')).toBeUndefined();
  expect(Reflect.get(live.parents('p'), 'childrenRegister')).toBeUndefined();
  expect(typeof Reflect.get(live.parents('p').children, 'register')).toBe('function');
});

test('nested lifecycle creates only the missing leaf and keeps parent state command-readonly', async () => {
  const calls: boolean[] = [];
  const child = createEntity('child', { id: '', value: '' }).events({
    changed(state, event: Event<{ parentsId: string; id: string; value: string }>) { state.value = event.payload.value; }
  }).commands(emit => ({
    register(state, payload: { parentsId: string; id: string; value: string }, context) {
      calls.push(context.isNew);
      if (payload.value === 'reject') throw new Error('rejected');
      return state.value === payload.value ? [] : emit.changed(payload);
    }
  }), { static: ['register'] }).build();
  const parent = createEntity('parent', { id: '', children: [] as { id: string; value: string }[] }).entityList('children', child).build();
  const host = createAggregate('nested', { parents: [{ id: 'p', children: [] as { id: string; value: string }[] }] })
    .entityList('parents', parent).build();
  const live = createMirage(host, 'root');
  const selected = live.parents('p');
  const register = selected.children.register;
  expect(() => Reflect.set(selected, 'id', 'other')).toThrow('Cannot mutate');
  const result = await register({ id: 'c', value: 'one' });
  expect(result).toEqual({ parents: [{ id: 'p', children: [{ id: 'c', value: 'one' }] }] });
  await register({ id: 'c', value: 'one' });
  await register({ id: 'c', value: 'two' });
  expect(() => register({ id: 'missing', value: 'reject' })).toThrow('rejected');
  expect(calls).toEqual([true, false, false, true]);
  expect(extractState(live).parents[0]!.children).toEqual([{ id: 'c', value: 'two' }]);
  expect(() => Reflect.set(result as object, 'parents', [])).toThrow();
  expect(() => live.parents('missing')).toThrow('Entity not found');
});
