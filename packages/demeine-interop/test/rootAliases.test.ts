import { createAggregate, createAggregatePlugin, createEntity, createMixin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

function entity(name = 'identifier') {
  return createEntity(name, { id: '', value: '' }).events({
    registered(state, event: Event<{ id: string; value: string }>) { Object.assign(state, event.payload); }
  }).commands(emit => ({
    register: { pack: (id: string, value: string) => ({ id, value }),
      handler: (_state: unknown, payload: { id: string; value: string }) => emit.registered(payload) },
    change: (_state: unknown, _payload: { id: string }) => []
  }), { static: ['register'] }).build();
}

test('aliases reuse flat functions, lifecycle, envelopes and packed arguments', async () => {
  const source = createAggregate('registry', { identifiers: [] as { id: string; value: string }[] })
    .entityList('identifiers', entity()).build();
  const host = source.withPlugins(createAggregatePlugin('audit')
    .commandEnvelope(() => ({ actor: 'host' }))
    .eventEnvelope((_, context) => ({ actor: context.command.actor })).build());
  const Bridge = createDemeineBridge(host);
  expect(Reflect.get(Bridge.prototype, 'registerIdentifier')).toBe(Bridge.prototype.identifiersRegister);
  const bridge = new Bridge();
  await Reflect.apply(Reflect.get(bridge, 'registerIdentifier'), bridge, ['one', 'first']);
  await bridge.identifiersRegister('one', 'second');
  expect(bridge._state.identifiers).toEqual([{ id: 'one', value: 'second' }]);
  expect(bridge.getVersion()).toBe(2);
  expect(bridge.getUncommittedEvents()).toHaveLength(2);
  expect(bridge.getUncommittedEvents()[0]).toMatchObject({ actor: 'host', aggregateId: bridge.id });
  expect(bridge.changeIdentifier).toBe(bridge.identifiersChange);
  await bridge.changeIdentifier({ id: 'one' });
  await expect(bridge.changeIdentifier({ id: 'missing' })).rejects.toThrow('Invalid mounted command target');
  expect(bridge.getVersion()).toBe(2);
});

test('semantic overrides ignore wire spelling; maps and descendants stay flat only', () => {
  const nested = createEntity('parent', { children: [] as { id: string; value: string }[] })
    .entityList('children', entity()).build();
  const host = createAggregate('registry', { rows: [], lookup: {}, parents: [] })
    .entityList('rows', entity(), {}, { semanticName: 'credential', commandNameOverrides: { register: 'CUSTOM.WIRE.command', change: 'CUSTOM.RENAME.command' } })
    .entityMap('lookup', entity('mapped'))
    .entityList('parents', nested).build();
  const bridge = new (createDemeineBridge(host))();
  expect(Reflect.get(bridge, 'registerCredential')).toBe(bridge.rowsRegister);
  expect(bridge.changeCredential).toBe(bridge.rowsChange);
  for (const name of ['registerIdentifier', 'changeIdentifier', 'registerMapped', 'changeMapped', 'childrenRegisterParent', 'childrenChangeParent', 'changeParent', 'registerParent', 'rows']) {
    expect(Reflect.get(bridge, name)).toBeUndefined();
  }
  expect(bridge.lookupRegister).toBeInstanceOf(Function);
  expect(bridge.parentsChildrenRegister).toBeInstanceOf(Function);
});

test('inherited and single-mixin-owned lists expose aliases', () => {
  const parent = createAggregate('parent', { rows: [] }).entityList('rows', entity());
  const inherited = createAggregate('child', { rows: [] }).extends(parent).build();
  const mixin = createMixin().entityList('rows', entity()).build();
  const mixed = createAggregate('mixed', { rows: [] }).mixins(mixin).build();
  for (const host of [inherited, mixed]) {
    const bridge = new (createDemeineBridge(host))();
    expect(Reflect.get(bridge, 'registerIdentifier')).toBe(bridge.rowsRegister);
    expect(bridge.changeIdentifier).toBe(bridge.rowsChange);
  }
});

test('shallow spread and assign retain aliases, including plugin-decorated definitions', async () => {
  const host = createAggregate('registry', { rows: [] }).entityList('rows', entity()).build();
  const decorated = host.withPlugins(createAggregatePlugin('audit').state(() => ({ count: 0 })).build());
  for (const definition of [host, decorated]) {
    for (const copy of [{ ...definition }, Object.assign({}, definition)]) {
      const bridge = new (createDemeineBridge(copy))();
      expect(Reflect.get(bridge, 'registerIdentifier')).toBe(bridge.rowsRegister);
      expect(bridge.changeIdentifier).toBe(bridge.rowsChange);
      await Reflect.apply(Reflect.get(bridge, 'registerIdentifier'), bridge, ['one', 'value']);
      await bridge.changeIdentifier({ id: 'one' });
      expect(bridge._state.rows).toEqual([{ id: 'one', value: 'value' }]);
      expect(bridge.getVersion()).toBe(1);
    }
  }
});

test('genuinely metadata-less structural builders retain only their flat methods', async () => {
  const structural = {
    aggregateType: 'counter', initialState: { count: 0 },
    types: { commands: { add: 'counter.add.command' }, events: { added: 'counter.added.event' } },
    commandCreators: { add: (amount: number) => ({ type: 'counter.add.command', payload: { amount } }) },
    process: () => [{ type: 'counter.added.event' as const, payload: {} }],
    apply: (state: { count: number }) => ({ count: state.count + 1 }),
  };
  const bridge = new (createDemeineBridge(structural))();
  await bridge.add(1);
  expect(bridge._state.count).toBe(1);
  expect(Reflect.get(bridge, 'addCounter')).toBeUndefined();
});

test('open command maps install only actual registered runtime aliases', async () => {
  const commands: Record<string, (state: unknown, payload: { id: string }) => []> = { change: () => [] };
  const patterned: Record<`change${string}`, (state: unknown, payload: { id: string }) => []> = { change: () => [] };
  for (const authored of [commands, patterned]) {
    const item = createEntity('identifier', { id: '' }).commands(() => authored).build();
    const host = createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', item).build();
    const bridge = new (createDemeineBridge(host))();
    expect(Reflect.get(bridge, 'changeIdentifier')).toBe(bridge.rowsChange);
    expect(Reflect.get(bridge, 'registerIdentifier')).toBeUndefined();
    expect(Reflect.get(bridge, 'changeMissingIdentifier')).toBeUndefined();
    await Reflect.apply(Reflect.get(bridge, 'changeIdentifier'), bridge, [{ id: 'a' }]);
    expect(bridge._state.rows).toEqual([{ id: 'a' }]);
  }
});

test('original no-payload spread repro reaches the same validation through alias and flat methods', async () => {
  const item = createEntity('identifier', { id: '' }).commands(() => ({ register: () => [], change: () => [] }), { static: ['register'] }).build();
  const host = createAggregate('registry', { rows: [] }).entityList('rows', item).build();
  const structural = { ...host };
  const bridge = new (createDemeineBridge(structural))();
  expect(bridge.registerIdentifier).toBe(bridge.rowsRegister);
  expect(bridge.changeIdentifier).toBe(bridge.rowsChange);
  await expect(bridge.registerIdentifier()).rejects.toThrow('Invalid mounted command target');
  await expect(bridge.rowsRegister()).rejects.toThrow('Invalid mounted command target');
  await expect(bridge.changeIdentifier()).rejects.toThrow('Invalid mounted command target');
  await expect(bridge.rowsChange()).rejects.toThrow('Invalid mounted command target');
  expect(bridge._state.rows).toEqual([]);
  expect(bridge.getVersion()).toBe(0);
});

test('replacement creators under existing keys serve flat methods and aliases identically', async () => {
  const host = createAggregate('registry', { rows: [] }).entityList('rows', entity()).build();
  const replacement = jest.fn((id: string, value: string) => host.commandCreators.rowsRegister(id, value.toUpperCase()));
  const copy = { ...host, commandCreators: { ...host.commandCreators, rowsRegister: replacement } };
  const bridge = new (createDemeineBridge(copy))();
  expect(Reflect.get(bridge, 'registerIdentifier')).toBe(bridge.rowsRegister);
  await Reflect.apply(Reflect.get(bridge, 'registerIdentifier'), bridge, ['one', 'alias']);
  await bridge.rowsRegister('one', 'flat');
  expect(replacement.mock.calls).toEqual([['one', 'alias'], ['one', 'flat']]);
  expect(bridge._state.rows).toEqual([{ id: 'one', value: 'FLAT' }]);
  expect(bridge.getUncommittedEvents().map(event => event.type)).toEqual([
    host.types.events.registered, host.types.events.registered
  ]);
});

test('duplicate aliases and root flat collisions fail deterministically', () => {
  const duplicate = createAggregate('registry', { one: [], two: [] })
    .entityList('one', entity()).entityList('two', entity()).build();
  expect(() => createDemeineBridge(duplicate)).toThrow('Legacy method collision: registerIdentifier');
  const root = createAggregate('registry', { rows: [] }).commands(() => ({ registerIdentifier: () => [] }))
    .entityList('rows', entity()).overrideCommandNames({ registerIdentifier: 'registry.root.command' }).build();
  expect(() => createDemeineBridge(root)).toThrow('Legacy method collision: registerIdentifier');
  const nonstatic = createAggregate('registry', { rows: [] }).commands(() => ({ changeIdentifier: () => [] }))
    .entityList('rows', entity()).overrideCommandNames({ changeIdentifier: 'registry.root.command' }).build();
  expect(() => createDemeineBridge(nonstatic)).toThrow('Legacy method collision: changeIdentifier');
  const firstNonstatic = createEntity('identifier', { id: '' }).commands(() => ({ change: () => [] })).build();
  const duplicateNonstatic = createAggregate('registry', { one: [], two: [] })
    .entityList('one', firstNonstatic).entityList('two', firstNonstatic).build();
  expect(() => createDemeineBridge(duplicateNonstatic)).toThrow('Legacy method collision: changeIdentifier');
});

test.each([['get', 'version', 'getVersion'], ['to', 'string', 'toString']])(
  'aliases cannot overwrite inherited members: %s + %s', (command, semantic, alias) => {
    for (const options of [{ static: [command] }, {}]) {
      const component = createEntity(semantic, { id: '' }).commands(() => ({ [command]: () => [] }), options).build();
      const host = createAggregate('registry', { rows: [] }).entityList('rows', component).build();
      expect(() => createDemeineBridge(host)).toThrow(`Legacy method collision: ${alias}`);
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  }
);

test.each(['__proto__', 'constructor', 'toString', 'then', 'id', 'getVersion'])(
  'original flat method protection remains intact for %s', name => {
    const host = createAggregate('registry', {}).build();
    const structural = { ...host, types: { commands: { [name]: 'registry.raw.command' }, events: {} },
      commandCreators: { [name]: () => ({ type: 'registry.raw.command', payload: {} }) } };
    expect(() => createDemeineBridge(structural)).toThrow(`Legacy method collision: ${name}`);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  }
);
