import { createAggregate, createAggregatePlugin, createEntity, createMixin } from '@redemeine/aggregate';
import { createDemeineBridge, type CompatibleAggregate } from '@redemeine/demeine-interop';

const item = createEntity('identifier', { id: '', value: '' }).commands(() => ({
  register: { pack: (id: string, value: string) => ({ id, value }), handler: () => [] },
  change: (_state: unknown, _payload: { id: string }) => [],
  restrict: (_state: unknown, _payload: { id: string; kind: 'fixed' }) => [],
  rename: { pack: (id: string, value: string, suffix?: string) => ({ id, value: value + (suffix ?? '') }), handler: () => [] },
  append: { pack: (id: string, ...values: string[]) => ({ id, values }), handler: () => [] },
  empty: () => [],
  literal: (_state: unknown, _payload: { kind: 'fixed' }) => [],
}), { static: ['register', 'empty', 'literal'] }).build();
const nested = createEntity('parent', { children: [] }).entityList('children', item).build();
const definition = createAggregate('registry', { rows: [], lookup: {}, parents: [] })
  .entityList('rows', item, {}, { semanticName: 'credential' })
  .entityMap('lookup', item).entityList('parents', nested).build();
export const Bridge = createDemeineBridge(definition);
const bridge = new Bridge();
const result: Promise<true | CompatibleAggregate<typeof definition.initialState>> = bridge.registerCredential('one', 'value');
void result;
bridge.emptyCredential();
bridge.literalCredential({ kind: 'fixed' });
bridge.rowsRegister('one', 'value');
const changed: typeof result = bridge.changeCredential({ id: 'one' });
const renamed: typeof result = bridge.renameCredential('one', 'value');
bridge.renameCredential('one', 'value', 'suffix');
bridge.appendCredential('one');
bridge.appendCredential('one', 'a', 'b');
bridge.restrictCredential({ id: 'one', kind: 'fixed' });
void [changed, renamed];
void bridge.lookupRegister;
const structural = { ...definition };
new (createDemeineBridge(structural))().registerCredential('one', 'value');
new (createDemeineBridge(structural))().changeCredential({ id: 'one' });
const assigned = Object.assign({}, structural);
new (createDemeineBridge(assigned))().registerCredential('one', 'value');
new (createDemeineBridge(assigned))().renameCredential('one', 'value');
const decorated = definition.withPlugins(createAggregatePlugin('audit').state(() => ({ count: 0 })).build());
new (createDemeineBridge({ ...decorated }))().registerCredential('one', 'value');
new (createDemeineBridge({ ...decorated }))().changeCredential({ id: 'one' });
const legacy = {
  aggregateType: 'counter', initialState: { count: 0 },
  types: { commands: { add: 'counter.add.command' }, events: { added: 'counter.added.event' } },
  commandCreators: { add: (amount: number) => ({ type: 'counter.add.command', payload: { amount } }) },
  process: () => [{ type: 'counter.added.event' as const, payload: {} }],
  apply: (state: { count: number }) => ({ count: state.count + 1 }),
};
new (createDemeineBridge(legacy))().add(1);

const inherited = createAggregate('child', { rows: [] })
  .extends(createAggregate('parent', { rows: [] }).entityList('rows', item)).build();
new (createDemeineBridge(inherited))().registerIdentifier('one', 'value');
new (createDemeineBridge(inherited))().changeIdentifier({ id: 'one' });
const mixed = createAggregate('mixed', { rows: [] })
  .mixins(createMixin().entityList('rows', item).build()).build();
new (createDemeineBridge(mixed))().registerIdentifier('one', 'value');
new (createDemeineBridge(mixed))().renameIdentifier('one', 'value');

const widened: { semanticName?: string } = {};
const dynamic = createAggregate('dynamic', { rows: [] }).entityList('rows', item, {}, widened).build();
const mapOnly = createAggregate('mapOnly', { entries: {} }).entityMap('entries', item).build();
const line = createEntity('line', { id: '', qty: 0 }).commands(() => ({
  set: { pack: (id: string, qty: number) => ({ id, qty }), handler: () => [] }
})).build();
const row = createEntity('row', { id: '', qty: 0 }).commands(() => ({ set: (_state: unknown, _payload: { id: string }) => [] })).build();
const order = createAggregate('order', { lines: [{ id: 'a', qty: 2 }], rows: [{ id: 'a', qty: 2 }] })
  .entityList('lines', line).entityList('rows', row).build();
const orderBridge = new (createDemeineBridge(order))();
orderBridge.setLine('a', 3);
orderBridge.setRow({ id: 'a' });
const widenedCommands: Record<string, (state: unknown, payload: { id: string }) => []> = { change: () => [] };
const widenedItem = createEntity('identifier', { id: '' }).commands(() => widenedCommands).build();
const widenedHost = createAggregate('widened', { rows: [{ id: 'a' }] }).entityList('rows', widenedItem).build();
const widenedBridge = new (createDemeineBridge(widenedHost))();
widenedBridge.rowsChange({ id: 'a' });
const indexedCommands: typeof widenedCommands & { rename: (state: unknown, payload: { id: string }) => [] } = {
  ...widenedCommands, rename: () => []
};
const indexedItem = createEntity('identifier', { id: '' }).commands(() => indexedCommands).build();
const indexedHost = createAggregate('indexed', { rows: [{ id: 'a' }] }).entityList('rows', indexedItem).build();
const indexedBridge = new (createDemeineBridge(indexedHost))();
indexedBridge.rowsRename({ id: 'a' });
if (false) {
  // @ts-expect-error widened command keys cannot promise a fabricated alias
  widenedBridge.registerIdentifier({ id: 'a' });
  // @ts-expect-error indexed command keys conservatively omit semantic aliases
  indexedBridge.registerIdentifier({ id: 'a' });
  // @ts-expect-error explicit keys mixed with an index signature remain conservative
  indexedBridge.renameIdentifier({ id: 'a' });
  // @ts-expect-error exact non-static packed target identity
  orderBridge.setLine(1, 3);
  // @ts-expect-error exact non-static packed payload
  orderBridge.setLine('a', '3');
  // @ts-expect-error object target identity cannot be omitted
  orderBridge.setRow({});
  // @ts-expect-error shallow copies retain exact packed argument types
  new (createDemeineBridge(structural))().registerCredential(1, 'value');
  // @ts-expect-error metadata-less structural builders have no semantic aliases
  new (createDemeineBridge(legacy))().addCounter(1);
  // @ts-expect-error exact packed arguments, not arbitrary payloads
  bridge.registerCredential({ id: 'one', value: 'value' });
  // @ts-expect-error required packed argument is retained
  bridge.registerCredential('one');
  // @ts-expect-error literal payload is retained
  bridge.literalCredential({ kind: 'other' });
  // @ts-expect-error authored semantic override replaces entity name
  bridge.registerIdentifier('one', 'value');
  // @ts-expect-error non-static aliases require the same target identity
  bridge.changeCredential({});
  // @ts-expect-error identity types remain exact
  bridge.changeCredential({ id: 1 });
  // @ts-expect-error non-static packed payload types remain exact
  bridge.renameCredential('one', 2);
  // @ts-expect-error non-static packed identity cannot be omitted
  bridge.renameCredential();
  // @ts-expect-error optional packed arguments retain their type
  bridge.renameCredential('one', 'value', 2);
  // @ts-expect-error rest packed arguments retain their type
  bridge.appendCredential('one', 2);
  // @ts-expect-error non-static literal payload remains narrow
  bridge.restrictCredential({ id: 'one', kind: 'other' });
  // @ts-expect-error aliases cannot be used as wider-payload handlers under strictFunctionTypes
  const acceptsAnyKind: (payload: { id: string; kind: string }) => unknown = bridge.restrictCredential;
  // @ts-expect-error maps have no root aliases
  new (createDemeineBridge(mapOnly))().registerIdentifier('one', 'value');
  // @ts-expect-error non-static map commands have no root aliases
  new (createDemeineBridge(mapOnly))().changeIdentifier({ id: 'one' });
  // @ts-expect-error nested descendant commands have no aliases
  bridge.childrenRegisterParent({ id: 'one', value: 'value' });
  // @ts-expect-error non-static descendants under a root list have no aliases
  bridge.childrenChangeParent({ id: 'one' });
  // @ts-expect-error widened semantic metadata cannot promise a fixed alias
  new (createDemeineBridge(dynamic))().registerIdentifier('one', 'value');
}
