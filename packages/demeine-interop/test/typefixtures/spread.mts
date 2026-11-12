import { commandMetadata, createAggregate, createAggregatePlugin, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '@redemeine/demeine-interop';

async function main() {
  const item = createEntity('identifier', { id: '' }).events({
    registered(state, event: Event<{ id: string }>) { state.id = event.payload.id; }
  }).commands(emit => ({
    register: (_state: unknown, payload: { id: string }) => emit.registered(payload),
    rename: (_state: unknown, payload: { id: string }) => emit.registered(payload)
  }),
  { static: ['register'] }).build();
  const host = createAggregate('registry', { rows: [] as { id: string }[] }).entityList('rows', item).build();
  const structural = { ...host };
  const bridge = new (createDemeineBridge(structural))();
  if (commandMetadata(structural, 'rowsRegister') !== commandMetadata(host, 'rowsRegister')) throw Error('lost snapshot');
  if (bridge.registerIdentifier !== bridge.rowsRegister) throw Error('missing alias');
  await bridge.registerIdentifier({ id: 'one' });
  if (bridge.renameIdentifier !== bridge.rowsRename) throw Error('missing non-static alias');
  await bridge.renameIdentifier({ id: 'one' });
  if (bridge._state.rows[0]?.id !== 'one' || bridge.getVersion() !== 2) throw Error('spread dispatch');
  const decorated = host.withPlugins(createAggregatePlugin('audit').state(() => ({ count: 0 })).build());
  const copied = Object.assign({}, { ...decorated });
  const decoratedBridge = new (createDemeineBridge(copied))();
  await decoratedBridge.registerIdentifier({ id: 'two' });
  if (decoratedBridge.renameIdentifier !== decoratedBridge.rowsRename) throw Error('missing decorated non-static alias');
  await decoratedBridge.renameIdentifier({ id: 'two' });
  if (decoratedBridge._state.rows[0]?.id !== 'two') throw Error('decorated spread dispatch');
  if (false) {
    // @ts-expect-error shallow copies preserve required payload shape
    bridge.registerIdentifier({ wrong: 'one' });
    // @ts-expect-error shallow copies cannot omit a required payload
    bridge.registerIdentifier();
    // @ts-expect-error decorated copies preserve the same payload shape
    decoratedBridge.registerIdentifier({ id: 1 });
    // @ts-expect-error non-static shallow copies retain target identity
    bridge.renameIdentifier({});
    // @ts-expect-error decorated non-static copies retain payload types
    decoratedBridge.renameIdentifier({ id: 1 });
  }
}
async function originalAuditorRepro() {
  const item = createEntity('identifier', { id: '' }).commands(() => ({ register: () => [], change: () => [] }), { static: ['register'] }).build();
  const host = createAggregate('registry', { rows: [] }).entityList('rows', item).build();
  const structural = { ...host };
  const bridge = new (createDemeineBridge(structural))();
  if (bridge.registerIdentifier !== bridge.rowsRegister) throw Error('missing original repro alias');
  if (bridge.changeIdentifier !== bridge.rowsChange) throw Error('missing non-static no-payload alias');
  // The original no-payload command has no entity identity. Both entrypoints
  // must reach the same existing Aggregate validation, not a missing-method error.
  const results = await Promise.allSettled([
    bridge.registerIdentifier(), bridge.rowsRegister(), bridge.changeIdentifier(), bridge.rowsChange()
  ]);
  for (const result of results) {
    if (result.status !== 'rejected' || !(result.reason instanceof Error)
      || result.reason.message !== 'Invalid mounted command target') throw Error('no-payload dispatch parity');
  }
  if (bridge._state.rows.length !== 0 || bridge.getVersion() !== 0) throw Error('implicit entity creation');
}
void Promise.all([main(), originalAuditorRepro()]);
