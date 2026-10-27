import { commandMetadata, type CommandMetadata, createAggregate, createEntity, createMixin } from '@redemeine/aggregate';
import { createMirage, createDepot, dispatch, extractState, subscribe, MirageCoreSymbol } from '@redemeine/mirage';
import type { Event } from '@redemeine/kernel';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type NestedParent = { id: string; children: { id: string }[] };
const nestedChild = createEntity<{ id: string }, 'nestedChild'>('nestedChild')
  .commands(() => ({ read: (_state, _payload: { id: string }) => [] })).build();
const nestedParent = createEntity<NestedParent, 'nestedParent'>('nestedParent').entityList('children', nestedChild)
  .commands(() => ({ touch: (_state, _payload: { id: string; note: string }) => [] })).build();
const nestedLater = createEntity<NestedParent, 'nestedLater'>('nestedLater').build();
export const nestedExposureHost = createAggregate('nested', { parents: [{ id: 'p', children: [{ id: 'c' }] }] })
  .entityList('parents', nestedParent).entityList('parents', nestedLater)
  .selectors(({ bindContext }) => ({ parent: state => bindContext(state.parents[0], nestedParent, { mount: 'parents' }) })).build();
const nestedLive = createMirage(nestedExposureHost, 'nested');
nestedLive.parents('p').touch({ note: 'ok' });
nestedLive.parent()!.touch({ note: 'bound' });
const noAnyNested: IsAny<typeof nestedLive.parents> = false;
// @ts-expect-error descendant identities cannot be supplied by a selected parent
nestedLive.parents('p').childrenRead({});
// @ts-expect-error bound earlier roles also omit unsupported descendants
nestedLive.parent()!.childrenRead({});
// @ts-expect-error parent business arguments remain checked, not never/any
nestedLive.parent()!.touch({ note: 2 });
nestedExposureHost.commandCreators.parentsChildrenRead({ id: 'c' });
void noAnyNested;
const nestedState = { parents: [{ id: 'p', children: [{ id: 'c' }] }] };
const nestedMixin = createMixin<typeof nestedState>().entityList('parents', nestedParent).build();
const mixedNested = createAggregate('mixedNested', nestedState).mixins(nestedMixin);
const inheritedNested = createAggregate('inheritedNested', nestedState).extends(mixedNested).build();
createMirage(inheritedNested, 'inherited').parents('p').touch({ note: 'ok' });
// @ts-expect-error ancestry survives mixin mounting and inheritance
createMirage(inheritedNested, 'inherited').parents('p').childrenRead({});
const namedNested = createAggregate('namedNested', { nestedParent: nestedState.parents }).entities({ nestedParent }).build();
createMirage(namedNested, 'named').nestedParent('p').touch({ note: 'ok' });
// @ts-expect-error explicit named maps preserve descendant ancestry
createMirage(namedNested, 'named').nestedParent('p').childrenRead({});
const mappedNested = createAggregate('mappedNested', { parents: { p: nestedState.parents[0]! } }).entityMap('parents', nestedParent).build();
createMirage(mappedNested, 'map').parents.p!.touch({ id: 'business', note: 'ok' });
// @ts-expect-error map scopes omit descendant commands too
createMirage(mappedNested, 'map').parents.p!.childrenRead({});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const Line = createEntity<{ id: string; qty: number }, 'line'>('line')
  .events({ changed: (state, event: Event<{ id: string; qty: number }>) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ set: (_state, payload: { id: string; qty: number; note?: string }) => emit.changed(payload),
    setObject: { handler: (_state: unknown, payload: { id: string; qty: number }) => emit.changed(payload), meta: { label: 'set' } },
    optional: (_state, payload: { id: string; qty?: number }) => emit.changed({ id: payload.id, qty: payload.qty ?? 0 }),
    packed: { pack: (id: string, body: { id: string; qty: number }) => Object.assign({ id }, body),
      handler: (_state: unknown, payload: { id: string; qty: number }) => emit.changed(payload) },
    setQty: { pack: (id: string, qty: number) => ({ id, qty }),
    handler: (_state: unknown, payload: { id: string; qty: number }) => emit.changed(payload) } })).build();
const builder = createAggregate('order', { total: 0, lines: [{ id: 'one', qty: 1 }] })
  .entityList('lines', Line).events({ added: (state, event: Event<number>) => { state.total += event.payload; } })
  .commands(emit => ({ add: (_state, value: number) => emit.added(value) }))
  .selectors(({ bindContext }) => ({
    count: state => state.total,
    hasLine: (state, id: string) => state.lines.some(line => line.id === id),
    selected: state => bindContext(state.lines, Line)
  })).build();
const live = createMirage(builder, 'one');
export const selectedCommandHost = createAggregate('selected', { lines: [{ id: 'one', qty: 1 }] }).entityList('lines', Line).build();
const registration: CommandMetadata | undefined = commandMetadata(selectedCommandHost, 'linesSet');
const noAnyRegistration: IsAny<NonNullable<typeof registration>> = false;
const readonlyTargets: readonly { readonly statePath: readonly string[] }[] | undefined = registration?.targets;
// @ts-expect-error registration query does not expose executable definitions
registration?.handler;
// @ts-expect-error registration target chains are readonly
registration!.targets.push({});
void [noAnyRegistration, readonlyTargets];
live.lines('one').set({ qty: 2 });
// Packed business arguments retain their authored shape; runtime enforces selection authority.
live.lines('one').packed({ id: 'other', qty: 2 });
// @ts-expect-error Packed business fields remain required.
live.lines('one').packed({ id: 'one' });
live.lines[0]!.setObject({ qty: 3 });
live.lines('one').optional();
live.lines('one').optional({ qty: 4 });
// @ts-expect-error Required business payload must not disappear with the injected ID.
live.lines('one').set();
// @ts-expect-error Business field types remain checked.
live.lines('one').set({ qty: 'wrong' });
// @ts-expect-error Required business fields remain required.
live.lines('one').set({});
// @ts-expect-error Selected identity is not caller input.
live.lines('one').set({ id: 'other', qty: 1 });
// @ts-expect-error Flat creators still require identity.
builder.commandCreators.linesSet({ qty: 1 });
builder.commandCreators.linesSet({ id: 'one', qty: 1 });
const count: number = live.count();
const version: number = live[MirageCoreSymbol].version;
// @ts-expect-error Diagnostics cannot modify the event-count invariant.
live[MirageCoreSymbol].version = 42;
// @ts-expect-error Mutable core operations are not exposed through diagnostics.
live[MirageCoreSymbol].clearPendingResults();
const exists: boolean = live.hasLine('one');
const noAnyState: IsAny<typeof live.total> = false;
const noAnySelector: IsAny<ReturnType<typeof live.count>> = false;
const selected = live.selected()[0]!;
selected.set({ qty: 4 });
[...live.lines][0]!.set({ qty: 5 });
const noAnyEntity: IsAny<typeof selected.qty> = false;
const preciseQty: Equal<typeof selected.qty, number> = true;
live.lines.filter(line => line.qty > 0)[0]!.setQty(2);
[...live.lines][0]!.setQty(3);
live.lines.at(-1)!.setQty(4);
// @ts-expect-error Unknown command must not be callable.
live.unknownCommand();
// @ts-expect-error Wrong command argument.
live.add('bad');
// @ts-expect-error Wrong selector argument.
live.hasLine(123);
// @ts-expect-error Read-side state is readonly.
live.total = 2;
// @ts-expect-error Entity state is readonly.
selected.qty = 4;
// @ts-expect-error Raw dispatch requires an envelope.
dispatch(live, 123);

const rawResult = dispatch(live, builder.commandCreators.add(2));
const noAnyDispatch: IsAny<typeof rawResult> = false;
const depot = createDepot(builder, { async *readStream() {}, async saveEvents() {} });
async function loadedApi() {
  const loaded = await depot.get('one');
  const preciseCount: Equal<ReturnType<typeof loaded.count>, number> = true;
  const state = await loaded.add(3);
  const noAnyResult: IsAny<typeof state> = false;
  // @ts-expect-error Command results are readonly.
  state.total = 10;
  const entity = await loaded.lines('one').setQty(3);
  const qty: number = entity.qty;
  // @ts-expect-error Scoped command returns entity state, not root state.
  entity.total;
  await depot.save(loaded);
  void [preciseCount, noAnyResult, qty];
}
subscribe(live, state => {
  const noAny: IsAny<typeof state> = false;
  // @ts-expect-error Subscribers cannot modify aggregate state.
  state.total = 3;
  void noAny;
});
const snapshot = extractState(live);
createMirage(builder, 'copy', { snapshot });
depot.get('copy', { snapshot: { state: snapshot, version: 0 } });
const noAnySnapshot: IsAny<typeof snapshot> = false;
const hydrated = createMirage(builder, 'one', { events: [] });
const promised: Promise<typeof live> = hydrated;
const Composite = createEntity<{ region: string; key: string; qty: number }, 'composite'>('composite')
  .events({ changed: (state, event: Event<{ region: string; key: string; qty: number }>) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ set: (_state, payload: { region: string; key: string; qty: number }) => emit.changed(payload),
    setQty: { pack: (region: string, key: string, qty: number) => ({ region, key, qty }),
    handler: (_state: unknown, payload: { region: string; key: string; qty: number }) => emit.changed(payload) },
    alias: { pack: (region: string, key: string, qty: number) => ({ entriesRegion: region, entriesKey: key, qty }), handler: () => [] },
    qualified: { pack: (region: string, key: string, body: { entriesRegion: string; qty: number }) => ({ region, key, ...body }), handler: () => [] }
  })).build();
const compositeBuilder = createAggregate('composite-root', { entries: [{ region: 'r', key: 'k', qty: 0 }] })
  .entityList('entries', Composite, { pk: ['region', 'key'] as const }).events({}).commands(() => ({}))
  .selectors(({ bindContext }) => ({ selected: state => bindContext(state.entries, Composite, { mount: 'entries' }) })).build();
const composite = createMirage(compositeBuilder, 'one');
composite.entries({ region: 'r', key: 'k' }).setQty(2);
composite.selected()[0]!.setQty(3);
composite.entries({ region: 'r', key: 'k' }).set({ qty: 2 });
composite.selected()[0]!.set({ qty: 3 });
composite.entries({ region: 'r', key: 'k' }).alias(2);
composite.selected()[0]!.qualified({ entriesRegion: 'other', qty: 2 });
// @ts-expect-error Composite alias-only pack retains required business arguments.
composite.selected()[0]!.alias();
// @ts-expect-error Composite qualified packed body retains required qty.
composite.selected()[0]!.qualified({ entriesRegion: 'r' });
// @ts-expect-error Composite selection still requires the business payload.
composite.selected()[0]!.set();
// @ts-expect-error Bound composite keys are injected; callers supply only the remaining command arguments.
composite.selected()[0]!.setQty('r', 'k', 3);
// @ts-expect-error Both primary-key fields are required.
composite.entries({ region: 'r' });
const MapEntry = createEntity<{ qty: number }, 'entry'>('entry').events({})
  .commands(() => ({ set: (_state, _payload: { key: string; qty: number }) => [],
    touch: { pack: (key: string) => ({ key }), handler: () => [] } })).build();
const mapBuilder = createAggregate('map', { entries: { one: { qty: 0 } } })
  .entityMap('entries', MapEntry, { knownKeys: ['one'] as const }).events({}).commands(() => ({})).build();
const map = createMirage(mapBuilder, 'map-one');
map.entries.one.touch();
map.entries.one.set({ qty: 2 });
// @ts-expect-error Map identity injection must not erase business fields.
map.entries.one.set();
// @ts-expect-error Map business fields remain checked.
map.entries.one.set({ qty: 'bad' });
const Custom = createEntity<{ code: string; qty: number }, 'custom'>('custom').events({})
  .commands(() => ({ set: (_state, _payload: { code: string; customId: string; qty: number; note?: string }) => [],
    alias: { pack: (code: string, qty: number) => ({ customsId: code, qty }), handler: () => [] },
    qualified: { pack: (code: string, body: { customsCode: string; qty: number }) => ({ code, ...body }), handler: () => [] }
  })).build();
const custom = createMirage(createAggregate('custom-root', { customs: [{ code: 'a', qty: 0 }] })
  .entityList('customs', Custom, { pk: 'code' }).build(), 'root');
custom.customs('a').set({ customId: 'business', qty: 1, note: 'optional' });
// @ts-expect-error Former identity aliases declared as business fields stay required.
custom.customs('a').set({ qty: 1 });
custom.customs('a').alias(2);
custom.customs[0]!.qualified({ customsCode: 'b', qty: 2 });
// @ts-expect-error Alias-only pack retains required business arguments.
custom.customs('a').alias();
// @ts-expect-error Qualified identity business argument does not erase qty.
custom.customs('a').qualified({ customsCode: 'a' });
// @ts-expect-error Custom keys are injected without erasing business fields.
custom.customs('a').set({ note: 'missing qty' });
const mapItems = [...map.entries];
const noAnyMapItem: IsAny<(typeof mapItems)[number]> = false;
const preciseMapQty: Equal<(typeof mapItems)[number]['qty'], number> = true;
for (const item of map.entries) {
  item.touch();
  // @ts-expect-error Iterated entities remain readonly.
  item.qty = 2;
  // @ts-expect-error The selected map key is injected, not a caller argument.
  item.touch('one');
}
void [noAnyMapItem, preciseMapQty];
// @ts-expect-error A map has no selected entity for a command on the collection itself.
map.entries.touch();
// @ts-expect-error Known-key maps must not invent other keys.
map.entries.missing.touch();
// @ts-expect-error Collection fields remain readonly.
map.entries.one.qty = 3;
const collision = createAggregate('collision', { count: 0 }).events({}).commands(() => ({}))
  .selectors({ count: state => state.count }).build();
// @ts-expect-error Reject known state/selector collisions before running the program.
createMirage(collision, 'one');
// @ts-expect-error Depot enforces the same namespace contract.
createDepot(collision, { async *readStream() {}, async saveEvents() {} });
// @ts-expect-error Snapshot state is inferred from the builder, not widened by options.
createMirage(builder, 'one', { snapshot: { total: 'bad', lines: [] } });
void [count, version, exists, noAnyState, noAnySelector, noAnyEntity, preciseQty, noAnyDispatch, noAnySnapshot, promised, loadedApi];
