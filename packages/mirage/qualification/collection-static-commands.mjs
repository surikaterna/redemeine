import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAggregate, createEntity, commandMetadata } from '@redemeine/aggregate';
import { createMirage, MirageCoreSymbol } from '@redemeine/mirage';

const entity = createEntity('identifier', { domain: '', authority: '', identifier: '' })
  .events({ registered(state, event) { state.identifier = event.payload.identifier; },
    amended(state, event) { state.identifier = event.payload.identifier; } })
  .commands(emit => {
    const register = (state, payload, { isNew }) => isNew ? emit.registered(payload)
      : state.identifier === payload.identifier ? [] : emit.amended(payload);
    return { register, packed: { pack: (domain, authority, identifier) => ({ domain, authority, identifier }), handler: register },
      ignore: () => [], ordinary: register };
  }, { static: ['register', 'packed', 'ignore'] }).build();
const host = createAggregate('registry', { identifiers: [] })
  .entityList('identifiers', entity, { pk: ['domain', 'authority'] }).build().withPlugins();
assert.equal(host.types.commands.identifiersRegister, 'registry.identifier.register.command');
assert.equal(commandMetadata(host, 'identifiersRegister').isStatic, true);
const live = createMirage(host, 'root');
const payload = { domain: 'd', authority: 'a', identifier: 'one' };
await live.identifiers.ignore(payload);
assert.equal(live.identifiers.length, 0);
assert.deepEqual(await live.identifiers.register(payload), { identifiers: [payload] });
assert.deepEqual(await live.registerIdentifier(payload), { identifiers: [payload] });
await live.identifiers.register(payload);
assert.equal(live[MirageCoreSymbol].version, 1);
assert.deepEqual(await live.identifiers.packed('d', 'a', 'two'), { identifiers: [{ ...payload, identifier: 'two' }] });
assert.deepEqual(await live.identifiers({ domain: 'd', authority: 'a' }).register({ identifier: 'three' }), { ...payload, identifier: 'three' });
assert.equal(live.identifiers.ordinary, undefined);
assert.throws(() => live.identifiers.register({ domain: 'd' }), /Invalid mounted command target/);
assert.throws(() => live.identifiers.push(payload), /Cannot mutate/);
assert.deepEqual([...live.identifiers].map(item => item.identifier), ['three']);
const aliases = createAggregate('aliases', { left: [], right: [] })
  .entityList('left', entity, { pk: ['domain', 'authority'] }, { semanticName: 'leftIdentifier', commandNameOverrides: { register: 'shared', packed: 'packed' } })
  .entityList('right', entity, { pk: ['domain', 'authority'] }, { semanticName: 'rightIdentifier', commandNameOverrides: { register: 'shared', packed: 'packed' } }).build();
const aliased = createMirage(aliases, 'root');
assert.deepEqual(await aliased.left.register(payload), { left: [], right: [payload] });
assert.deepEqual(await aliased.right.register(payload), { left: [], right: [payload] });
assert.deepEqual(await aliased.registerLeftIdentifier(payload), { left: [], right: [payload] });
assert.deepEqual(await aliased.registerRightIdentifier(payload), { left: [], right: [payload] });
const updated = { ...payload, identifier: 'two' };
assert.deepEqual(await aliased.left.packed('d', 'a', 'two'), { left: [], right: [updated] });
assert.deepEqual(await aliased.right.packed('d', 'a', 'two'), { left: [], right: [updated] });
const readOnly = createEntity('readOnly', { domain: '', authority: '', identifier: '' }).build();
assert.throws(() => createAggregate('invalid', { rows: [] }).entityList('rows', entity)
  .entityList('rows', readOnly).build(), /rows.*identifier.*readOnly/);
const ambiguous = createEntity('ambiguous', { id: '' }).commands(() => ({ register: () => [], Register: () => [] })).build();
assert.throws(() => createAggregate('invalid', { rows: [] }).entityList('rows', ambiguous).build(),
  /rows\.register.*rows\.Register.*rowsRegister/);
const parent = createEntity('parent', { code: '', region: '', identifiers: [] })
  .entityList('identifiers', entity, { pk: ['domain', 'authority'] }).build();
const nestedHost = createAggregate('nested', { parents: [{ code: 'p', region: 'r', identifiers: [] }] })
  .entityList('parents', parent, { pk: ['code', 'region'] }).build();
assert.equal(nestedHost.types.commands.parentsIdentifiersRegister, 'nested.parent.identifier.register.command');
const nested = createMirage(nestedHost, 'nested', { plugins: [{ key: 'async', async onBeforeCommand() {} }] });
const selectedParent = nested.parents({ code: 'p', region: 'r' });
const aliasResult = selectedParent.packedIdentifier('d', 'a', 'nested');
assert(aliasResult instanceof Promise);
assert.deepEqual(await aliasResult, { parents: [{ code: 'p', region: 'r', identifiers: [{ ...payload, identifier: 'nested' }] }] });
const identifiers = nested.parents({ code: 'p', region: 'r' }).identifiers;
assert.equal(identifiers.length, 1);
await identifiers.ignore(payload);
assert.equal(identifiers.length, 1);
const nestedResult = identifiers.packed('d', 'a', 'nested');
assert(nestedResult instanceof Promise);
assert.deepEqual(await nestedResult, { parents: [{ code: 'p', region: 'r', identifiers: [{ ...payload, identifier: 'nested' }] }] });
assert.equal(Reflect.set((await nestedResult).parents[0], 'code', 'wrong'), false);
assert.throws(() => identifiers.register({ ...payload, parentsCode: 'wrong' }), /Conflicting ancestor identity/);
assert.throws(() => selectedParent.registerIdentifier({ ...payload, parentsCode: 'wrong' }), /Conflicting ancestor identity/);
assert.deepEqual(await identifiers({ domain: 'd', authority: 'a' }).register({ identifier: 'selected' }), { ...payload, identifier: 'selected' });
assert.equal(nested.parents({ code: 'p', region: 'r' }).identifiersRegister, undefined);
assert.equal(identifiers.ordinary, undefined);
assert.equal(selectedParent.ordinaryIdentifier, undefined);
assert.throws(() => nested.parents({ code: 'missing', region: 'r' }), /Entity not found/);
const payloadToken = Symbol('packed');
class PackedPayload {
  constructor(id) { Object.defineProperty(this, 'id', { value: id }); this[payloadToken] = 'symbol'; }
  read() { return this.id; }
}
const borrowed = Object.freeze(new PackedPayload('c'));
const seen = [];
const packedLeaf = createEntity('packedLeaf', { id: '' }).commands(() => ({
  packed: { pack: () => borrowed, handler(_state, value) {
    assert.equal(value.read(), 'c');
    assert.equal(value[payloadToken], 'symbol');
    assert.deepEqual(Object.getOwnPropertyDescriptor(value, 'id'), Object.getOwnPropertyDescriptor(borrowed, 'id'));
    seen.push(value); return [];
  } },
  optional(_state, value) { assert.equal(value.parentsId, 'p'); assert.equal(value.id, 'c'); return []; }
}), { static: ['packed', 'optional'] }).build();
const packedParent = createEntity('packedParent', { id: '', leaves: [] }).entityList('leaves', packedLeaf).build();
const packedHost = createAggregate('packedPayload', { leaves: [], parents: [{ id: 'p', leaves: [] }] })
  .entityList('leaves', packedLeaf).entityList('parents', packedParent).build();
const packedLive = createMirage(packedHost, 'root');
packedLive.leaves.packed();
packedLive.parents('p').leaves.packed();
packedLive.parents('p').leaves.optional({ id: 'c' });
assert.equal(seen[0], borrowed);
assert.notEqual(seen[1], borrowed);
assert.equal(seen[1].parentsId, 'p');
assert.equal(Object.hasOwn(borrowed, 'parentsId'), false);
assert(Object.isFrozen(borrowed));
async function qualifySemanticBridge(aggregate, interop) {
  const leaf = aggregate.createEntity('identifier', { id: '', value: '' })
    .events({ registered(state, event) { state.value = event.payload.value; } })
    .commands(emit => ({ register: { pack: (id, value) => ({ id, value }),
      handler(_state, payload) { return emit.registered(payload); } } }), { static: ['register'] }).build();
  const customer = aggregate.createEntity('customer', { id: '', identifiers: [] }).entityList('identifiers', leaf).build();
  const definition = aggregate.createAggregate('party', { left: [], right: [], customers: [{ id: 'c', identifiers: [] }] })
    .entityList('left', leaf).entityList('right', leaf).entityList('customers', customer).build();
  assert.equal(definition.types.commands.leftRegister, 'party.identifier.register.command');
  assert.equal(definition.types.commands.rightRegister, definition.types.commands.leftRegister);
  assert.equal(definition.types.commands.customersIdentifiersRegister, 'party.customer.identifier.register.command');
  const Bridge = interop.createDemeineBridge(definition);
  const bridge = new Bridge();
  let native = definition.initialState;
  for (const name of ['leftRegister', 'rightRegister']) {
    for (const event of definition.process(native, definition.commandCreators[name]('i', name))) {
      assert.equal(event.type, 'party.identifier.registered.event');
      native = definition.apply(native, event);
    }
    await bridge[name]('i', name);
    assert.deepEqual(bridge._state, native);
    assert.deepEqual(native.left, []);
  }
  const aliasedParent = aggregate.createEntity('aliasParent', { id: '', identifiers: [] })
    .entityList('identifiers', leaf, {}, { semanticName: 'credential' }).build();
  const aliasDefinition = aggregate.createAggregate('publicAliases', { rows: [], parents: [{ id: 'p', identifiers: [] }] })
    .entityList('rows', leaf, {}, { semanticName: 'rootCredential' }).entityList('parents', aliasedParent)
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.parents[0], aliasedParent, { mount: 'parents' }) })).build();
  assert.equal(aliasDefinition.types.commands.rowsRegister, 'publicAliases.rootCredential.register.command');
  assert.equal(aliasDefinition.types.commands.parentsIdentifiersRegister, 'publicAliases.aliasParent.credential.register.command');
  const aliasLive = createMirage(aliasDefinition, 'public');
  assert.deepEqual(await aliasLive.registerRootCredential('i', 'root'), { rows: [{ id: 'i', value: 'root' }], parents: [{ id: 'p', identifiers: [] }] });
  assert.deepEqual(await aliasLive.parents('p').registerCredential('i', 'nested'), {
    rows: [{ id: 'i', value: 'root' }], parents: [{ id: 'p', identifiers: [{ id: 'i', value: 'nested' }] }]
  });
  assert.equal(aliasLive.registerRows, undefined);
  assert.equal(aliasLive.parents('p').registerIdentifier, undefined);
  assert.equal(aliasLive.chosen().registerCredential, undefined);
}
await qualifySemanticBridge(await import('@redemeine/aggregate'), await import('@redemeine/demeine-interop'));
const require = createRequire(import.meta.url);
await qualifySemanticBridge(require('@redemeine/aggregate'), require('@redemeine/demeine-interop'));
console.log('PASS explicit root and nested list static collection commands from installed packages');
