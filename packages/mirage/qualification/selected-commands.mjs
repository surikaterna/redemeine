import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, extractState, MirageCoreSymbol } from '@redemeine/mirage';

function entity(createEntity, fields, calls = [], prefix = 'items') {
  return createEntity('item').events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({
      set(state, payload) {
        calls.push('handler');
        assert.throws(() => { state.qty = 100; });
        assert.equal(typeof payload.qty, 'number');
        return emit.changed({ ...payload, qty: state.qty + payload.qty });
      },
      setObject: { handler: (state, payload) => emit.changed({ ...payload, qty: state.qty + payload.qty }), meta: { label: 'object' } },
      setQuantity: { pack: (...args) => Object.fromEntries([...fields, 'qty'].map((key, index) => [key, args[index]])),
        handler: (state, payload) => emit.changed({ ...payload, qty: state.qty + payload.qty }) },
      packed: { pack: (...args) => Object.assign(Object.fromEntries(fields.map((key, index) => [key, args[index]])), args[fields.length]),
        handler: (state, payload) => { calls.push('handler'); return emit.changed({ ...payload, qty: state.qty + payload.qty }); } },
      missing: { pack: () => ({ qty: 2 }), handler: () => { calls.push('handler'); } },
      primitive: { pack: () => 2, handler: () => { calls.push('handler'); } },
      aliasOnly: { pack: (...args) => Object.fromEntries([...fields, 'qty'].map((key, index) =>
        [key === 'qty' ? key : `${prefix}${fields.length === 1 && key === 'code' ? 'Id' : key.charAt(0).toUpperCase() + key.slice(1)}`, args[index]])),
        handler: (state, payload) => { calls.push('handler'); return emit.changed({ ...payload, qty: state.qty + payload.qty }); } }
    })).build();
}

function rejectsBeforeDispatch(live, selected, fields, identity, calls) {
  const state = extractState(live);
  const pending = live[MirageCoreSymbol].getPendingResults();
  const previous = [...calls];
  for (const field of fields) {
    for (const value of ['other', undefined, false, {}]) {
      assert.throws(() => selected.packed({ [field]: value, qty: 2 }), /identity/i);
      assert.throws(() => selected.set({ [field]: value, qty: 2 }), /identity/i);
    }
  }
  if (!Object.hasOwn(identity, 'key')) {
    for (const field of Object.keys(identity)) {
      assert.throws(() => selected.packed({ __entityPk: { [field]: 'other' }, qty: 2 }), /identity/i);
    }
  }
  assert.throws(() => selected.missing(), /identity/i);
  assert.throws(() => selected.primitive());
  assert.deepEqual(calls, previous);
  assert.deepEqual(extractState(live), state);
  assert.deepEqual(live[MirageCoreSymbol].getPendingResults(), pending);
  selected.packed({ ...identity, qty: 1 });
}

function scalarParity(api, pk) {
  const fields = Array.isArray(pk) ? pk : [pk];
  const identity = Object.fromEntries(fields.map((field, index) => [field, index ? '' : 0]));
  const payload = { ...identity, [fields[0]]: '0', qty: 2 };
  const item = entity(api.createEntity, fields);
  const host = api.createAggregate('scalar', { items: [{ ...identity, qty: 1 }] }).entityList('items', item, { pk }).build();
  const command = host.commandCreators.itemsSet(payload);
  const result = host.process(host.initialState, command);
  const live = createMirage(host, 'scalar');
  const selected = live.items(Array.isArray(pk) ? identity : 0);
  selected.set(payload);
  assert.equal(selected.qty, 3);
  selected.packed(payload);
  assert.equal(selected.qty, 5);
  assert.equal(host.apply(host.initialState, result[0]).items[0].qty, 3);
  for (const value of [false, undefined, {}, 'other']) assert.throws(() => selected.set({ [fields[0]]: value, qty: 2 }), /identity/i);
}

for (const api of [{ createAggregate, createEntity }, createRequire(import.meta.url)('@redemeine/aggregate')]) {
  for (const pk of ['id', 'code', ['domain', 'authority']]) {
    const fields = Array.isArray(pk) ? pk : [pk];
    const identity = Object.fromEntries(fields.map(key => [key, `${key}-a`]));
    const other = Object.fromEntries(fields.map(key => [key, `${key}-b`]));
    const calls = [];
    const item = entity(api.createEntity, fields, calls);
    const host = api.createAggregate('store', { items: [{ ...identity, qty: 1 }, { ...other, qty: 20 }] })
      .entityList('items', item, { pk })
      .selectors(({ bindContext }) => ({ selected: state => bindContext(state.items, item) })).build();
    host.hooks = { onBeforeCommand() { calls.push('hook'); } };
    const live = createMirage(host, 'store');
    const key = Array.isArray(pk) ? identity : identity[pk];
    const aliasCommand = host.commandCreators.itemsAliasOnly(...Object.values(identity), 2);
    const aliasResult = host.process(host.initialState, aliasCommand);
    assert.equal(host.apply(host.initialState, aliasResult[0]).items[0].qty, 3);
    const selected = live.items(key);
    selected.set({ qty: 2 });
    live.items[0].setObject({ qty: 3 });
    [...live.items][0].setQuantity(4);
    assert.equal(selected.qty, 10);
    assert.equal(live.items[1].qty, 20);
    live.selected()[0].set({ qty: 1 });
    assert.equal(selected.qty, 11);
    selected.set({ ...identity, qty: 1 });
    assert.equal(selected.qty, 12);
    assert.throws(() => selected.set({ ...other, qty: 1 }), /identity/i);
    assert.throws(() => selected.set(), /number/);
    for (const target of [selected, live.items[0], [...live.items][0], live.selected()[0]]) {
      const aliases = fields.flatMap(field => [`items${field.charAt(0).toUpperCase()}${field.slice(1)}`, `item${field.charAt(0).toUpperCase()}${field.slice(1)}`]);
      rejectsBeforeDispatch(live, target, [...fields, ...aliases, ...(typeof pk === 'string' ? ['itemsId', 'itemId'] : [])], identity, calls);
      for (const alias of aliases) assert.throws(() => target.set({ [alias]: 'other', qty: 2 }), /identity/i);
      const previousQty = target.qty;
      target.aliasOnly(2);
      assert.equal(target.qty, previousQty + 2);
    }
    if (Array.isArray(pk)) selected.packed({ id: 'business-not-identity', qty: 1 });
    const events = live[MirageCoreSymbol].getPendingResults().events;
    const hydrated = await createMirage(host, 'store', { events });
    assert.deepEqual(extractState(hydrated), extractState(live));
    assert.deepEqual(host.commandCreators.itemsSet({ ...identity, qty: 2 }).payload, { ...identity, qty: 2 });
    assert(Object.values(host.metadata.commands).some(value => value.meta?.label === 'object'));
  }
  for (const pk of ['id', 'code', ['domain', 'authority']]) scalarParity(api, pk);
  const calls = [];
  const item = entity(api.createEntity, ['key'], calls, 'entries');
  const host = api.createAggregate('map', { entries: { one: { qty: 1 }, two: { qty: 20 }, '0': { qty: 1 }, '': { qty: 1 } } }).entityMap('entries', item).build();
  host.hooks = { onBeforeCommand() { calls.push('hook'); } };
  const live = createMirage(host, 'map');
  const native = host.process(host.initialState, host.commandCreators.entriesSet({ key: 0, id: 'business', qty: 2 }));
  assert.equal(host.apply(host.initialState, native[0]).entries['0'].qty, 3);
  live.entries.one.set({ qty: 2 });
  [...live.entries].find(entry => entry.qty === 3).setQuantity(3);
  assert.equal(live.entries.one.qty, 6);
  assert.throws(() => live.entries.one.set({ key: 'two', qty: 1 }), /identity/i);
  rejectsBeforeDispatch(live, live.entries.one, ['key', 'entriesKey', 'entrieKey'], { key: 'one', id: 'business' }, calls);
  live.entries['0'].set({ key: 0, id: 'business', qty: 2 });
  live.entries['0'].packed({ key: 0, id: 'business', qty: 2 });
  assert.equal(live.entries['0'].qty, 5);
  live.entries[''].packed({ key: '', qty: 2 });
  assert.equal(live.entries[''].qty, 3);
  live.entries[''].aliasOnly(2);
  assert.equal(live.entries[''].qty, 5);
  assert.throws(() => live.entries['0'].set({ key: false, qty: 2 }), /identity/i);
}
console.log('PASS selected shorthand/packed commands, Aggregate ESM/CJS and Mirage ESM');
