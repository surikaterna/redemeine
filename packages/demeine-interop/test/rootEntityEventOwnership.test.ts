import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const probe = `
const initial = () => ({ count: 10, identifiers: [{ id: 'a', count: 2 }, { id: 'b', count: 7 }] });
const rootProjector = (state, event) => { state.count = event.payload.count; };
const childProjector = (state, event) => { state.count = event.payload.count; };
const entity = createEntity('identifier').events({ registered: {
  projector: childProjector, meta: { owner: 'entity' }
} }).commands(emit => ({ register(state, payload) {
  assert.equal(state.count, 2);
  assert.throws(() => Reflect.set(state, 'count', 999));
  return emit.registered({ ...payload, count: state.count + 1 });
} })).build();
const builder = createAggregate('payment_attempt', initial()).events({ registered: {
  projector: rootProjector, meta: { owner: 'root' }
} }).entityList('identifiers', entity).commands(emit => ({ register(state, payload) {
  assert.equal(state.count, 10);
  return emit.registered({ ...payload, count: state.count + 1 });
} }));
function replay(host, event, expected) {
  const before = initial();
  assert.deepEqual(host.apply(before, event), expected);
  assert.deepEqual(produce(before, draft => host.applyToDraft(draft, event)), expected);
  assert.deepEqual(before, initial());
}
async function check(host) {
  assert.equal(host.pure.eventProjectors.registered, rootProjector);
  const root = host.process(initial(), host.commandCreators.register({ id: 'a' }))[0];
  assert.equal(root.type, 'payment_attempt.registered.event');
  assert.deepEqual(root.payload, { id: 'a', count: 11 });
  assert.deepEqual(host.metadata.events[root.type].meta, { owner: 'root' });
  replay(host, root, { ...initial(), count: 11 });
  const child = host.process(initial(), host.commandCreators.identifiersRegister({ id: 'a' }))[0];
  assert.equal(child.type, 'payment_attempt.identifier.registered.event');
  assert.deepEqual(child.payload, { id: 'a', count: 3 });
  assert.deepEqual(host.metadata.events[child.type].meta, { owner: 'entity' });
  replay(host, child, { ...initial(), identifiers: [{ id: 'a', count: 3 }, { id: 'b', count: 7 }] });
  const Bridge = createDemeineBridge(host);
  const bridge = new Bridge();
  await bridge.register({ id: 'a' });
  assert.deepEqual(bridge._state, host.apply(initial(), root));
  await bridge.identifiersRegister({ id: 'a' });
  assert.deepEqual(bridge._state, host.apply(host.apply(initial(), root), child));
  assert.equal(bridge.getVersion(), 2);
  assert.deepEqual(host.initialState, initial());
}
async function main() {
  await check(builder.build());
  await check(builder.build());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

test.each(['module', 'commonjs'])('public %s root/entity same-key ownership and bridge replay', format => {
  const load = format === 'module' ? 'await import' : 'require';
  const imports = `
    const { createAggregate, createEntity } = ${load}('@redemeine/aggregate');
    const { createDemeineBridge } = ${load}('@redemeine/demeine-interop');
    const { produce } = ${load}('immer');
    const { strict: assert } = ${load}('node:assert');
  `;
  expect(() => execFileSync(process.execPath, [`--input-type=${format}`, '-e', imports + probe], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000
  })).not.toThrow();
});
