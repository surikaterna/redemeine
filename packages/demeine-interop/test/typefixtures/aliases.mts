import { createAggregate, createAggregatePlugin, createEntity, createMixin } from '@redemeine/aggregate';
import { createDemeineBridge, type CompatibleAggregate } from '@redemeine/demeine-interop';

const item = createEntity('identifier', { id: '', value: '' }).commands(() => ({
  register: { pack: (id: string, value: string) => ({ id, value }), handler: () => [] },
  change: (_state: unknown, _payload: { id: string }) => [],
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
void bridge.lookupRegister;
const structural = { ...definition };
new (createDemeineBridge(structural))().registerCredential('one', 'value');
const assigned = Object.assign({}, structural);
new (createDemeineBridge(assigned))().registerCredential('one', 'value');
const decorated = definition.withPlugins(createAggregatePlugin('audit').state(() => ({ count: 0 })).build());
new (createDemeineBridge({ ...decorated }))().registerCredential('one', 'value');
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
const mixed = createAggregate('mixed', { rows: [] })
  .mixins(createMixin().entityList('rows', item).build()).build();
new (createDemeineBridge(mixed))().registerIdentifier('one', 'value');

const widened: { semanticName?: string } = {};
const dynamic = createAggregate('dynamic', { rows: [] }).entityList('rows', item, {}, widened).build();
const mapOnly = createAggregate('mapOnly', { entries: {} }).entityMap('entries', item).build();
if (false) {
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
  // @ts-expect-error instance commands have no aliases
  bridge.changeCredential({ id: 'one' });
  // @ts-expect-error maps have no root aliases
  new (createDemeineBridge(mapOnly))().registerIdentifier('one', 'value');
  // @ts-expect-error nested descendant commands have no aliases
  bridge.childrenRegisterParent({ id: 'one', value: 'value' });
  // @ts-expect-error widened semantic metadata cannot promise a fixed alias
  new (createDemeineBridge(dynamic))().registerIdentifier('one', 'value');
}
