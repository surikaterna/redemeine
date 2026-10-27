import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '@redemeine/aggregate';
import { produce } from 'immer';

const cjs = createRequire(import.meta.url)('@redemeine/aggregate');
const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const scopes = [[false, false], [false, true], [true, false], [true, true]];

function checkRoot(api, key, explicit) {
  const events = { [key]: { projector(draft) { assert.equal(this, undefined); draft.qty++; }, meta: { event: key } } };
  const commands = { [key]: { pack(qty) { return { qty }; }, handler(_state, payload) { return emit[key](payload); }, meta: { command: key } } };
  let emit;
  const builder = api.createAggregate('probe', { qty: 0 }).events(events).commands(e => { emit = e; return commands; });
  if (explicit) builder.overrideCommandNames({ [key]: '__proto__' }).overrideEventNames({ [key]: '__proto__' });
  for (const host of [builder.build(), builder.build().withPlugins(api.createAggregatePlugin('trace').eventEnvelope(() => ({ traced: true })).build())]) {
    const command = host.commandCreators[key](3);
    const query = api.commandMetadata(host, key);
    assert.equal(query.wireType, command.type);
    assert.equal(query.isWireWinner, true);
    assert.deepEqual(query.targets, []);
    const [event] = host.process(host.initialState, command);
    assert.equal(event.type, host.types.events[key]);
    assert.deepEqual(host.metadata.commands[command.type].meta, { command: key });
    assert.deepEqual(host.metadata.events[event.type].meta, { event: key });
    assert.deepEqual(host.apply(host.initialState, event), { qty: 1 });
    assert.deepEqual(produce({ qty: 0 }, draft => host.applyToDraft(draft, event)), { qty: 1 });
    assert.equal(host.commandCreators.missing, undefined);
    assert.equal(api.commandMetadata(host, 'missing'), undefined);
  }
  for (const input of [commands, events]) {
    assert.equal(Object.getPrototypeOf(input), Object.prototype);
    assert.equal(Object.hasOwn(input, key), true);
    assert.equal(Object.isFrozen(input), false);
  }
}

function checkScoped(api, key, flattened, nested, withRoot) {
  const pk = ['id'];
  const row = api.createEntity('row').events({ [key](draft, event) { draft.qty = event.payload.qty; } })
    .commands(emit => ({ [key]: (_state, payload) => emit[key](payload) })).build();
  const parent = api.createEntity('parent').entityList('rows', row, { pk }).build();
  const mixin = nested ? api.createMixin().entityList('parents', parent).build() : api.createMixin().entityList('rows', row, { pk }).build();
  const state = { qty: 0, rows: [{ id: 'a', qty: 1 }], parents: [{ id: 'p', rows: [{ id: 'a', qty: 1 }] }] };
  const root = api.createAggregate('probe', state);
  if (withRoot) root.events({ [key](draft) { draft.qty++; } }).commands(emit => ({ [key]: () => emit[key]({}) }));
  const builder = flattened ? root.mixins({ ...mixin, mountedEntities: [] }) : nested ? root.entityList('parents', parent) : root.entityList('rows', row, { pk });
  const local = `${nested ? 'parentsRows' : 'rows'}${key[0].toUpperCase()}${key.slice(1)}`;
  for (const host of [builder.build(), builder.build().withPlugins()]) {
    const query = api.commandMetadata(host, local);
    assert.equal(query.targets.length, nested ? 2 : 1);
    assert.equal(Object.isFrozen(query.targets), true);
    assert.equal(Reflect.set(query.targets[0].statePath, '0', 'wrong'), false);
    const [event] = host.process(state, host.commandCreators[local]({ parentsId: 'p', id: 'a', qty: 3 }));
    const expected = structuredClone(state);
    (nested ? expected.parents[0] : expected).rows[0].qty = 3;
    assert.deepEqual(host.apply(state, event), expected);
    const draft = structuredClone(state); host.applyToDraft(draft, event); assert.deepEqual(draft, expected);
    assert.throws(() => host.apply(state, { ...event, payload: {} }), /Invalid mounted command target/);
    if (withRoot) {
      const [rootEvent] = host.process(state, host.commandCreators[key]());
      assert.equal(host.apply(state, rootEvent).qty, 1);
    } else assert.equal(host.commandCreators[key], undefined);
  }
  assert.deepEqual(pk, ['id']);
  assert.equal(Object.isFrozen(pk), false);
}

for (const api of [esm, cjs]) {
  for (const key of names) {
    for (const explicit of [false, true]) checkRoot(api, key, explicit);
    for (const [flattened, nested] of scopes) {
      checkScoped(api, key, flattened, nested, false);
      checkScoped(api, key, flattened, nested, true);
    }
  }
  const host = api.createAggregate('winner', {}).commands(() => ({ ['__proto__']: () => [], constructor: () => [] }))
    .overrideCommandNames({ ['__proto__']: '__proto__', constructor: '__proto__' }).build();
  assert.equal(api.commandMetadata(host, '__proto__').winnerLocalName, 'constructor');
  assert.equal(api.commandMetadata(host, 'constructor').isWireWinner, true);
  assert.deepEqual(host.process({}, host.commandCreators[names[0]]()), []);
  const empty = api.createAggregate('empty', {}).build();
  for (const key of names) assert.equal(empty.commandCreators[key], undefined);
}
console.log('PASS Aggregate ESM/CJS prototype-like local/wire registrations, scoped ownership and replay');
