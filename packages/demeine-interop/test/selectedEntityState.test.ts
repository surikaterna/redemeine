import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test.each(['__proto__', 'constructor', 'toString'])('bridge preserves own canonical %s identity predicates', async field => {
  for (const pk of [field, [field, 'region']]) {
    const calls = jest.fn();
    const row = createEntity<{ qty: number }, 'row'>('row')
      .events({ changed(state, event: Event<{ qty: number }>) { state.qty = event.payload.qty; } })
      .commands(emit => ({ set(state, payload: Record<string, unknown>) {
        calls(); return emit.changed({ ...payload, qty: state.qty + 1 });
      } })).build();
    const state = { qty: 99, rows: [{ [field]: 'actual', region: 'west', qty: 1 }] };
    const host = createAggregate('store', state).entityList('rows', row, { pk }).build();
    const Bridge = createDemeineBridge(host);
    const bridge = new Bridge();
    const input = { [field]: 'actual', region: 'west', __entityPk: 'business', id: 'business' };
    await bridge.rowsSet(input);
    expect(bridge._state.rows[0]!.qty).toBe(2);
    calls.mockClear();
    await expect(bridge.rowsSet({ ...input, [field]: 'MISSING' })).rejects.toThrow('Invalid mounted command target');
    expect(calls).not.toHaveBeenCalled();
    expect(bridge._state.rows[0]!.qty).toBe(2);
    expect(bridge.getVersion()).toBe(1);
    expect(state.rows[0]!.qty).toBe(1);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  }
});

test('bridge flat mounted method matches native creator/process/apply and preserves packed definitions', async () => {
  const pack = (id: string, qty: number) => ({ id, qty });
  const line = createEntity<{ id: string; qty: number }, 'line'>('line')
    .events({ changed(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set: {
      pack, meta: { description: 'set quantity' },
      handler(state, payload: ReturnType<typeof pack>) {
        return emit.changed({ id: payload.id, qty: state.qty + payload.qty });
      }
    } })).build();
  const host = createAggregate('order', { lines: [{ id: 'a', qty: 2 }] }).entityList('lines', line).build();
  const command = host.commandCreators.linesSet('a', 3);
  const events = host.process(host.initialState, command);
  const expected = host.apply(host.initialState, events[0]!);
  const Bridge = createDemeineBridge(host);
  const bridge = new Bridge();
  await bridge.linesSet('a', 3);
  expect(bridge._state).toEqual(expected);
  expect(expected.lines[0]!.qty).toBe(5);
  expect(Reflect.get(host.pure.commandProcessors.linesSet!, 'pack')).toBe(pack);
  expect(host.metadata.commands[command.type]).toEqual({ meta: { description: 'set quantity' } });
  await expect(bridge.linesSet('missing', 3)).rejects.toThrow('Invalid mounted command target');
  expect(bridge._state).toEqual(expected);
  expect(bridge.getVersion()).toBe(1);
});

test.each(['list', 'map'] as const)('bridge replays nested %s parents with list and map children like native apply', async kind => {
  const child = createEntity<{ id: string; qty: number }, 'child'>('child')
    .events({ changed(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload: Record<string, unknown>) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const parent = createEntity<{ id: string; children: { id: string; qty: number }[]; byKey: Record<string, { id: string; qty: number }> }, 'parent'>('parent')
    .entityList('children', child, {}, { semanticName: 'children' }).entityMap('byKey', child, {}, { semanticName: 'byKey' }).build();
  const parents = [1, 2].map(n => ({ id: `p${n}`, children: [{ id: 'same', qty: n }], byKey: { same: { id: 'same', qty: n } } }));
  const state = { qty: 99, parents, byParent: { p1: structuredClone(parents[0]!), p2: structuredClone(parents[1]!) } };
  const host = createAggregate('store', state).entityList('parents', parent).entityMap('byParent', parent, {}, { semanticName: 'byParent' }).build();
  for (const leaf of ['Children', 'ByKey'] as const) {
    const prefix = kind === 'list' ? 'parents' : 'byParent';
    const name = `${prefix}${leaf}Set` as const;
    const payload = { [kind === 'list' ? 'parentsId' : 'byParentKey']: 'p2', [leaf === 'Children' ? 'id' : 'key']: 'same' };
    const event = host.process(state, { type: host.types.commands[name], payload })[0]!;
    const expected = structuredClone(state);
    const selected = kind === 'list' ? expected.parents[1]! : expected.byParent.p2;
    if (leaf === 'Children') selected.children[0]!.qty = 3;
    else selected.byKey.same!.qty = 3;
    expect(host.apply(state, event)).toEqual(expected);
    const Bridge = createDemeineBridge(host);
    const bridge = new Bridge();
    await bridge[name](payload);
    expect(bridge._state).toEqual(expected);
  }
});

const collisionProbe = String.raw`
const changed = (state, event) => { state.qty = event.payload.qty; };
let calls = 0;
function entities() {
  const first = createEntity('first').events({ bChanged: changed }).commands(emit => ({
    bSet(state, payload) { calls++; return emit.bChanged({ ...payload, qty: state.qty + 1 }); }
  })).build();
  const second = createEntity('second').events({ changed }).commands(emit => ({
    set(state, payload) { calls++; return emit.changed({ ...payload, qty: state.qty + 1 }); }
  })).build();
  return { first, second };
}
function mount(builder, first, second, overrides) {
  return builder.entityList('a', first, {}, overrides).entityList('sibling', second).entityList('a', first, {}, overrides);
}
function hostFor(kind, alias, siblingId) {
  const { first, second } = entities();
  const overrides = alias ? { commandNameOverrides: { bSet: 'custom.winningSet.command' }, eventNameOverrides: { bChanged: 'custom.winningChanged.event' } } : {};
  const inner = { id: 'p', a: [{ id: 'chosen', qty: 2 }], sibling: [{ id: siblingId, qty: 7 }] };
  const builder = createAggregate('store', { ...inner, parents: [structuredClone(inner)] });
  if (kind === 'direct') return mount(builder, first, second, overrides).build();
  if (kind === 'mixin') return builder.mixins(mount(createMixin(), first, second, overrides).build()).build();
  return builder.entityList('parents', mount(createEntity('parent'), first, second, overrides).build()).build();
}
async function check(kind, alias, siblingId) {
  const host = hostFor(kind, alias, siblingId);
  const name = kind === 'nested' ? 'parentsABSet' : 'aBSet';
  const payload = { parentsId: 'p', id: 'chosen' };
  const before = structuredClone(host.initialState);
  const event = host.process(host.initialState, host.commandCreators[name](payload))[0];
  assert.deepEqual(event.payload, { ...payload, qty: 3 });
  const expected = structuredClone(before);
  (kind === 'nested' ? expected.parents[0] : expected).a[0].qty = 3;
  assert.deepEqual(host.apply(host.initialState, event), expected);
  assert.deepEqual(produce(host.initialState, draft => host.applyToDraft(draft, event)), expected);
  const Bridge = createDemeineBridge(host);
  const bridge = new Bridge();
  await bridge[name](payload);
  assert.deepEqual(bridge._state, expected);
  const missing = structuredClone(before);
  (kind === 'nested' ? missing.parents[0] : missing).a = [];
  calls = 0;
  assert.throws(() => host.process(missing, host.commandCreators[name](payload)), /Invalid mounted command target/);
  assert.equal(calls, 0);
  bridge._state = missing;
  await assert.rejects(() => bridge[name](payload), /Invalid mounted command target/);
  assert.equal(calls, 0);
  assert.deepEqual(bridge._state, missing);
  assert.equal(bridge.getVersion(), 1);
  assert.deepEqual(host.initialState, before);
}
async function main() {
  for (const pk of ['id', 'code', ['id', 'domain']]) await checkLeafBlob(pk);
  for (const alias of [false, true]) await checkFlattened(alias);
  for (const kind of ['direct', 'mixin', 'nested']) {
    for (const alias of [false, true]) {
      for (const siblingId of ['chosen', 'sibling']) await check(kind, alias, siblingId);
    }
  }
}
async function checkLeafBlob(pk) {
  const fields = Array.isArray(pk) ? pk : [pk];
  const child = createEntity('child').events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const children = [{ id: 'c', code: 'c', domain: 'leaf', qty: 2 }];
  const parent = createEntity('parent').entityList('children', child, { pk }).build();
  const host = createAggregate('store', { parents: [
    { id: 'other', code: 'other', domain: 'ancestor', children: structuredClone(children) },
    { id: 'p', code: 'p', domain: 'ancestor', children }
  ] }).entityList('parents', parent, { pk }).build();
  const ancestor = Object.fromEntries(fields.map(field => ['parents' + field[0].toUpperCase() + field.slice(1), field === 'domain' ? 'ancestor' : 'p']));
  const identity = Object.fromEntries(fields.map(field => [field, field === 'domain' ? 'leaf' : 'c']));
  for (const canonical of [false, true]) {
    const payload = { ...ancestor, ...(canonical ? identity : {}), __entityPk: { business: true }, qty: 2 };
    if (!canonical) {
      assert.throws(() => host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload)), /Invalid mounted command target/);
      continue;
    }
    const before = structuredClone(payload);
    const event = host.process(host.initialState, host.commandCreators.parentsChildrenSet(payload))[0];
    const expected = structuredClone(host.initialState);
    expected.parents[1].children[0].qty = 3;
    assert.deepEqual(host.apply(host.initialState, event), expected);
    assert.deepEqual(produce(host.initialState, draft => host.applyToDraft(draft, event)), expected);
    const Bridge = createDemeineBridge(host);
    const bridge = new Bridge();
    await bridge.parentsChildrenSet(payload);
    assert.deepEqual(bridge._state, expected);
    assert.deepEqual(payload, before);
  }
  const field = fields[0];
  assert.throws(() => host.process(host.initialState, host.commandCreators.parentsChildrenSet({
    ...ancestor, ...identity, [field]: 'wrong'
  })), /Invalid mounted command target/);
  assert.throws(() => host.process(host.initialState, host.commandCreators.parentsChildrenSet({ __entityPk: identity })), /Invalid mounted command target/);
}
async function checkFlattened(alias) {
  let writes = 0;
  const entity = createEntity('row').events({ changed(state, event) { writes++; state.qty = event.payload.qty; } })
    .commands(emit => ({ set(state, payload) { return emit.changed({ ...payload, qty: state.qty + 1 }); } })).build();
  const before = { qty: 99, rows: [{ id: 'a', qty: 2 }] };
  const source = createMixin().entityList('rows', entity, {}, alias ? { eventNameOverrides: { changed: 'custom.changed.event' } } : {}).build();
  const builder = createAggregate('store', before).mixins({ ...source, mountedEntities: [] });
  for (const host of [builder.build(), builder.build()]) {
    const event = host.process(before, host.commandCreators.rowsSet({ id: 'a' }))[0];
    assert.deepEqual(event.payload, { id: 'a', qty: 3 });
    const expected = { qty: 99, rows: [{ id: 'a', qty: 3 }] };
    assert.deepEqual(host.apply(before, event), expected);
    assert.deepEqual(produce(before, draft => host.applyToDraft(draft, event)), expected);
    const Bridge = createDemeineBridge(host);
    const bridge = new Bridge();
    await bridge.rowsSet({ id: 'a' });
    assert.deepEqual(bridge._state, expected);
    const missing = { qty: 99, rows: [] };
    writes = 0;
    assert.throws(() => host.apply(missing, event), /Invalid mounted command target/);
    assert.throws(() => host.applyToDraft(missing, event), /Invalid mounted command target/);
    bridge._state = missing;
    await assert.rejects(() => bridge.rowsSet({ id: 'missing' }), /Invalid mounted command target/);
    assert.equal(writes, 0);
    assert.deepEqual(bridge._state, missing);
    assert.equal(bridge.getVersion(), 1);
    assert.deepEqual(before, { qty: 99, rows: [{ id: 'a', qty: 2 }] });
  }
  const root = createMixin().events({ rowsChanged(state, event) { state.qty = event.payload.qty + 10; } }).build();
  const replacement = createAggregate('store', before).mixins({ ...source, mountedEntities: [] }, root);
  for (const host of [replacement.build(), replacement.build()]) {
    const event = { type: host.types.events.rowsChanged, payload: { id: 'missing', qty: 3 } };
    const expected = { ...before, qty: 13 };
    assert.deepEqual(host.apply(before, event), expected);
    assert.deepEqual(produce(before, draft => host.applyToDraft(draft, event)), expected);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

test.each(['module', 'commonjs'])('public %s A-B-A provenance preserves native and bridge replay', format => {
  const load = format === 'module' ? 'await import' : 'require';
  const imports = `
    const { createAggregate, createEntity, createMixin } = ${load}('@redemeine/aggregate');
    const { createDemeineBridge } = ${load}('@redemeine/demeine-interop');
    const { produce } = ${load}('immer');
    const { strict: assert } = ${load}('node:assert');
  `;
  expect(() => execFileSync(process.execPath, [`--input-type=${format}`, '-e', imports + collisionProbe], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000
  })).not.toThrow();
});
