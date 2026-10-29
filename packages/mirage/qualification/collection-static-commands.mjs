import assert from 'node:assert/strict';
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
assert.equal(commandMetadata(host, 'identifiersRegister').isStatic, true);
const live = createMirage(host, 'root');
const payload = { domain: 'd', authority: 'a', identifier: 'one' };
await live.identifiers.ignore(payload);
assert.equal(live.identifiers.length, 0);
assert.deepEqual(await live.identifiers.register(payload), { identifiers: [payload] });
await live.identifiers.register(payload);
assert.equal(live[MirageCoreSymbol].version, 1);
assert.deepEqual(await live.identifiers.packed('d', 'a', 'two'), { identifiers: [{ ...payload, identifier: 'two' }] });
assert.deepEqual(await live.identifiers({ domain: 'd', authority: 'a' }).register({ identifier: 'three' }), { ...payload, identifier: 'three' });
assert.equal(live.identifiers.ordinary, undefined);
assert.throws(() => live.identifiers.register({ domain: 'd' }), /Invalid mounted command target/);
assert.throws(() => live.identifiers.push(payload), /Cannot mutate/);
assert.deepEqual([...live.identifiers].map(item => item.identifier), ['three']);
const aliases = createAggregate('aliases', { left: [], right: [] })
  .entityList('left', entity, { pk: ['domain', 'authority'] }, { commandNameOverrides: { register: 'shared', packed: 'packed' } })
  .entityList('right', entity, { pk: ['domain', 'authority'] }, { commandNameOverrides: { register: 'shared', packed: 'packed' } }).build();
const aliased = createMirage(aliases, 'root');
assert.deepEqual(await aliased.left.register(payload), { left: [], right: [payload] });
assert.deepEqual(await aliased.right.register(payload), { left: [], right: [payload] });
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
const nested = createMirage(nestedHost, 'nested', { plugins: [{ key: 'async', async onBeforeCommand() {} }] });
const identifiers = nested.parents({ code: 'p', region: 'r' }).identifiers;
assert.equal(identifiers.length, 0);
await identifiers.ignore(payload);
assert.equal(identifiers.length, 0);
const nestedResult = identifiers.packed('d', 'a', 'nested');
assert(nestedResult instanceof Promise);
assert.deepEqual(await nestedResult, { parents: [{ code: 'p', region: 'r', identifiers: [{ ...payload, identifier: 'nested' }] }] });
assert.equal(Reflect.set((await nestedResult).parents[0], 'code', 'wrong'), false);
assert.throws(() => identifiers.register({ ...payload, parentsCode: 'wrong' }), /Conflicting ancestor identity/);
assert.deepEqual(await identifiers({ domain: 'd', authority: 'a' }).register({ identifier: 'selected' }), { ...payload, identifier: 'selected' });
assert.equal(nested.parents({ code: 'p', region: 'r' }).identifiersRegister, undefined);
assert.equal(identifiers.ordinary, undefined);
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
console.log('PASS explicit root and nested list static collection commands from installed packages');
