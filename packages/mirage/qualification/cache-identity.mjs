import assert from 'node:assert/strict';
import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, extractState, MirageCoreSymbol } from '@redemeine/mirage';

function qualify(pk, value) {
  const rows = [{ id: value, code: value, domain: value, authority: 'a', qty: 1 }];
  const item = createEntity('item')
    .events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ add: (state, payload) => emit.changed({ ...payload, qty: state.qty + payload.qty }) })).build();
  const host = createAggregate('store', { rows }).entityList('rows', item, { pk })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], item, { mount: 'rows' }) })).build();
  const live = createMirage(host, 'store');
  const identity = typeof pk === 'string' ? { [pk]: String(value) } : { authority: 'a', domain: String(value) };
  const direct = live.rows(typeof pk === 'string' ? String(value) : identity);
  const selections = [direct, live.rows[0], [...live.rows][0], live.chosen()];
  for (const selected of selections) assert.equal(selected.qty, 1);
  const events = host.process(host.initialState, host.commandCreators.rowsAdd({ ...identity, qty: 2 }));
  const native = events.reduce((state, event) => host.apply(state, event), host.initialState);
  direct.add({ qty: 2 });
  assert.deepEqual(extractState(live), native);
  for (const selected of selections) assert.equal(selected.qty, 3);
  assert.equal(extractState(live).rows[0].id, value);
  assert.equal(live[MirageCoreSymbol].getPendingResults().events.length, 1);
  assert.equal(rows[0].qty, 1);
}

for (const pk of ['id', 'code', ['domain', 'authority']]) {
  for (const value of [0n, 0, 9007199254740992n, 9007199254740993n]) qualify(pk, value);
}
