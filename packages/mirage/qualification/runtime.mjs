import assert from 'node:assert/strict';
import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, createDepot, extractState, extractUncommittedEvents } from '@redemeine/mirage';

const entity = createEntity('entry').events({ changed: (state, event) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ setQty: { pack: (id, qty) => ({ id, qty }), handler: (_state, payload) => emit.changed(payload) } })).build();
const builder = createAggregate('order', { entries: [{ id: 'a', qty: 1 }] })
  .entityList('entries', entity).events({}).commands(() => ({ noop: () => [] }))
  .selectors(({ bindContext }) => ({ byId: (state, id) => state.entries.find(entry => entry.id === id),
    selected: state => bindContext(state.entries, entity) })).build();
const live = createMirage(builder, 'one');
const other = createMirage(builder, 'two');
assert.equal(String(live), '[object Object]');
assert.equal(String(live.entries[0]), '[object Object]');
assert.equal(await Promise.resolve(live), live);
assert.throws(() => { live.entries[0].qty = 99; });
await [...live.entries][0].setQty(3);
assert.equal(live.byId('a').qty, 3);
assert.equal(other.byId('a').qty, 1);
assert.equal((await live.selected()[0].setQty(4)).qty, 4);
assert.equal(extractUncommittedEvents(live).length, 2);
const snapshot = extractState(live);
assert.throws(() => { snapshot.entries[0].qty = 99; });
const depot = createDepot(builder, { async *readStream() {}, async saveEvents() {} });
const loaded = await depot.get('one', { snapshot: { state: snapshot, version: 2 } });
assert.equal(loaded.byId('a').qty, 4);
assert.equal((await loaded.noop()).entries[0].qty, 4);
await depot.save(loaded);
const role = createEntity('subset').events({}).selectors({ enabled: state => state.id === 'a' })
  .commands(() => ({ setQty: () => [] }))
  .commands((_emit, ctx) => {
    assert.equal(ctx.selectors.enabled({ id: 'a' }), true);
    assert.ok(ctx.commands.setQty());
    return { setQty: () => [] };
  }).build();
const subsetBuilder = createAggregate('subset-root', { entries: [{ id: 'a', qty: 1 }] })
  .entityList('entries', entity).events({}).commands(() => ({}))
  .selectors(({ bindContext }) => ({ selected: state => bindContext(state.entries[0], role, { mount: 'entries' }) })).build();
const subset = createMirage(subsetBuilder, 'subset-one');
assert.equal((await subset.selected().setQty(5)).qty, 5);
const mapEntity = createEntity('map-entry').events({ changed: (state, event) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ setQty: { pack: (key, qty) => ({ key, qty }), handler: (_state, payload) => emit.changed(payload) } })).build();
const mapBuilder = createAggregate('map-root', { entries: { a: { qty: 1 }, b: { qty: 2 } } })
  .entityMap('entries', mapEntity).events({}).commands(() => ({})).build();
const map = createMirage(mapBuilder, 'map-one');
const retained = [...map.entries];
assert.throws(() => { retained[0].qty = 99; });
for (const item of map.entries) await item.setQty(item.qty + 1);
assert.deepEqual(retained.map(item => item.qty), [2, 3]);
assert.deepEqual(extractUncommittedEvents(map).map(event => event.payload.key), ['a', 'b']);
console.log('Packed immutable command/selector/collection/Depot behavior passed');
