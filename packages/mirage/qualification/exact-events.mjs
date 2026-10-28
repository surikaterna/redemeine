import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '@redemeine/aggregate';

const cjs = createRequire(import.meta.url)('@redemeine/aggregate');

function snapshotFixture(api, nested, flattened, decorated) {
  const pk = ['id', 'region'];
  const parentPk = ['id'];
  const rows = [{ id: 'a', code: 'b', region: 'x', qty: 1 }, { id: 'b', code: 'a', region: 'x', qty: 10 }];
  const parentState = { id: 'p', code: 'q', qty: 99, rows: structuredClone(rows) };
  const state = { qty: 99, rows, parents: [parentState, { ...structuredClone(parentState), id: 'q', code: 'p' }] };
  const projector = function(draft, event) { assert.equal(this, undefined); draft.qty = event.payload.qty; };
  const row = api.createEntity('row').events({ changed: projector })
    .commands(emit => ({ set: (selected, input) => emit.changed({ ...input, qty: selected.qty + 2 }) })).build();
  const parent = api.createEntity('parent').entityList('rows', row, { pk }).build();
  const sourceBuilder = api.createMixin();
  const source = nested ? sourceBuilder.entityList('parents', parent, { pk: parentPk }).build()
    : sourceBuilder.entityList('rows', row, { pk }).build();
  const builder = api.createAggregate('store', state);
  const built = flattened ? builder.mixins({ ...source, mountedEntities: [] }).build()
    : nested ? builder.entityList('parents', parent, { pk: parentPk }).build() : builder.entityList('rows', row, { pk }).build();
  const host = decorated ? built.withPlugins() : built;
  const mounts = flattened ? source.mounts : host.mounts;
  const chain = Object.values(mounts[nested ? 'parents' : 'rows'].eventTargets)[0];
  const command = nested ? host.types.commands.parentsRowsSet : host.types.commands.rowsSet;
  const input = { parentsId: 'p', id: 'a', region: 'x', code: 'a' };
  const expected = structuredClone(state);
  (nested ? expected.parents[0] : expected).rows[0].qty = 3;
  assert.equal(Object.isFrozen(projector), false);
  assert.equal(Reflect.set(projector, 'callerMarker', true), true);
  return { host, state, chain, pk, parentPk, command, input, expected };
}

function checkSnapshot(api, nested, flattened, decorated, mutation) {
  const { host, state, chain, pk, parentPk, command, input, expected } = snapshotFixture(api, nested, flattened, decorated);
  const query = api.commandMetadata(host, nested ? 'parentsRowsSet' : 'rowsSet');
  assert.equal(Reflect.set(query.targets, 'length', 0), false);
  for (const step of query.targets) {
    assert.equal(Reflect.set(step, 'kind', 'map'), false);
    assert.equal(Reflect.set(step.statePath, '0', 'missing'), false);
    assert.equal(Reflect.set(step.pk, '0', 'wrong'), false);
  }
  if (mutation === 'chain') assert.equal(Reflect.set(chain, 'length', 0), true);
  if (mutation === 'statePath') for (const step of chain) assert.equal(Reflect.set(step.statePath, '0', 'missing'), true);
  if (mutation === 'step') for (const step of chain) assert.equal(Reflect.set(step, 'kind', 'map'), true);
  if (mutation === 'callerPk') {
    assert.equal(Object.isFrozen(pk), false);
    assert.equal(Object.isFrozen(parentPk), false);
    pk[0] = 'code'; parentPk[0] = 'code';
    assert.deepEqual(pk, ['code', 'region']);
  }
  const [event] = host.process(state, { type: command, payload: input });
  assert.deepEqual(event.payload, { ...input, qty: 3 });
  assert.deepEqual(host.apply(state, event), expected);
  const draft = structuredClone(state);
  host.applyToDraft(draft, event);
  assert.deepEqual(draft, expected);
  assert.throws(() => host.apply(state, { type: event.type, payload: {} }), /Invalid mounted command target/);
  assert.throws(() => host.applyToDraft(structuredClone(state), { type: event.type, payload: {} }), /Invalid mounted command target/);
}

for (const api of [esm, cjs]) {
  for (const [nested, flattened, decorated] of [
    [false, false, false], [false, false, true], [false, true, false], [false, true, true],
    [true, false, false], [true, false, true], [true, true, false], [true, true, true]
  ]) {
    for (const mutation of ['chain', 'statePath', 'step', 'callerPk']) checkSnapshot(api, nested, flattened, decorated, mutation);
  }
}

for (const api of [esm, cjs]) {
  assert.equal('parseTargetedEventPath' in api, false);
  const unmatched = [];
  const row = api.createEntity('row').events({ changed(draft, event) { draft.qty = event.payload.qty; } })
    .commands(emit => ({ set: (_state, payload) => emit.changed(payload) })).build();
  const builder = api.createAggregate('store', { qty: 99, rows: [{ code: 'a', qty: 1 }] })
    .events({ changed(draft) { draft.qty++; } }).overrideEventNames({ changed: 'store.dotted.root.event' })
    .entityList('rows', row, { pk: 'code' }).onUnmatchedEvent((type, name) => unmatched.push([type, name]));
  for (const host of [builder.build(), builder.build().withPlugins()]) {
    const state = host.initialState;
    const [event] = host.process(state, host.commandCreators.rowsSet({ code: 'a', qty: 3 }));
    assert.equal(event.type, 'store.rows.changed.event');
    assert.deepEqual(host.apply(state, event), { qty: 99, rows: [{ code: 'a', qty: 3 }] });
    const draft = structuredClone(state);
    host.applyToDraft(draft, event);
    assert.equal(draft.rows[0].qty, 3);
    assert.equal(host.apply(state, { type: 'store.dotted.root.event', payload: {} }).qty, 100);
    for (const type of ['store.changed.event', 'store.rows.dotted.root.event']) {
      assert.deepEqual(host.apply(state, { type, payload: { code: 'a', qty: 3 } }), state);
      assert.deepEqual(unmatched.at(-1), [type, 'store']);
    }
    assert.throws(() => host.apply(state, { type: event.type, payload: {} }), /Invalid mounted command target/);
  }
}
console.log('PASS packed Aggregate ESM/CJS exact event dispatch, detached target snapshots, and retired parser absence');
