import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '@redemeine/aggregate';
import { createDemeineBridge } from '@redemeine/demeine-interop';
import { createMirage } from '@redemeine/mirage';

const cjs = createRequire(import.meta.url)('@redemeine/aggregate');

async function checkIdentity(api, field, composite) {
  let calls = 0;
  const row = api.createEntity('row').events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload) { calls++; return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const pk = composite ? [field, 'region'] : field;
  const state = JSON.parse(`{"qty":99,"rows":[{"${field}":"actual","region":"west","qty":1}]}`);
  const host = api.createAggregate('store', state).entityList('rows', row, { pk }).build();
  const input = { [field]: 'actual', region: 'west', __entityPk: 'business', id: 'business' };
  const before = structuredClone(state);
  const [event] = host.process(state, host.commandCreators.rowsSet(input));
  assert.deepEqual(event.payload, { ...input, qty: 2 });
  const expected = structuredClone(state);
  expected.rows[0].qty = 2;
  assert.deepEqual(host.apply(state, event), expected);
  const draft = structuredClone(state);
  host.applyToDraft(draft, event);
  assert.deepEqual(draft, expected);
  const Bridge = createDemeineBridge(host);
  const bridge = new Bridge();
  await bridge.rowsSet(input);
  assert.deepEqual(bridge._state, expected);
  for (const missing of [{ ...input, [field]: 'MISSING' }, ...(composite ? [{ ...input, region: 'MISSING' }] : [])]) {
    calls = 0;
    assert.throws(() => host.process(state, host.commandCreators.rowsSet(missing)), /Invalid mounted command target/);
    assert.throws(() => host.apply(state, { ...event, payload: missing }), /Invalid mounted command target/);
    assert.throws(() => host.applyToDraft(structuredClone(state), { ...event, payload: missing }), /Invalid mounted command target/);
    await assert.rejects(() => bridge.rowsSet(missing), /Invalid mounted command target/);
    assert.equal(calls, 0);
    assert.deepEqual(bridge._state, expected);
  }
  checkMirage(host, field, composite);
  assert.deepEqual(state, before);
  assert.deepEqual(input, { [field]: 'actual', region: 'west', __entityPk: 'business', id: 'business' });
  assert.equal(Object.getPrototypeOf(state.rows[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
}

function checkMirage(host, field, composite) {
  // Mirage reserves toString as a proxy protocol independently of canonical routing.
  if (field === 'toString') {
    assert.throws(() => createMirage(host, 'one'), /protocol name is reserved/);
    return;
  }
  const live = createMirage(host, 'one');
  const selected = live.rows(composite ? { [field]: 'actual', region: 'west' } : 'actual');
  selected.set({ __entityPk: 'business', id: 'business' });
  assert.equal(selected.qty, 2);
  assert.throws(() => live.rows(composite ? { [field]: 'MISSING', region: 'west' } : 'MISSING'), /Entity not found/);
}

function checkDeclarations(api) {
  const row = api.createEntity('row').build();
  for (const pk of ['', [], [''], ['id', 'id'], null, 0, false, {}, ['id', 3]]) {
    for (const builder of [api.createAggregate('store', {}), api.createEntity('parent'), api.createMixin()]) {
      assert.throws(() => builder.entityList('rows', row, { pk }).build(), /Invalid mounted command target/);
    }
  }
  for (const kind of ['direct', 'nested', 'mixin', 'flattened', 'inherited']) {
    const pk = ['id'];
    const direct = api.createAggregate('store', {}).entityList('rows', row, { pk });
    const parent = api.createEntity('parent').entityList('rows', row, { pk }).build();
    const mixin = api.createMixin().entityList('rows', row, { pk }).build();
    const builder = kind === 'nested' ? api.createAggregate('store', {}).entityList('parents', parent)
      : kind === 'mixin' ? api.createAggregate('store', {}).mixins(mixin)
      : kind === 'flattened' ? api.createAggregate('store', {}).mixins({ ...mixin, mountedEntities: [] })
      : kind === 'inherited' ? api.createAggregate('store', {}).extends(direct) : direct;
    pk.push('id');
    assert.throws(() => builder.build(), /Invalid mounted command target/);
    assert.equal(Object.isFrozen(pk), false);
  }
}

for (const api of [esm, cjs]) {
  checkDeclarations(api);
  for (const field of ['__proto__', 'constructor', 'toString']) {
    for (const composite of [false, true]) await checkIdentity(api, field, composite);
  }
}
console.log('PASS packed ESM/CJS canonical own-key predicates, bridge/Mirage parity, and all-mount PK validation');
