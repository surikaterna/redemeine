import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createMirage, createDepot, dispatch, extractState, subscribe, MirageCoreSymbol } from '@redemeine/mirage';
import type { Event } from '@redemeine/kernel';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const Line = createEntity<{ id: string; qty: number }, 'line'>('line')
  .events({ changed: (state, event: Event<{ id: string; qty: number }>) => { state.qty = event.payload.qty; } })
  .commands(emit => ({ setQty: { pack: (id: string, qty: number) => ({ id, qty }),
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
  .commands(emit => ({ setQty: { pack: (region: string, key: string, qty: number) => ({ region, key, qty }),
    handler: (_state: unknown, payload: { region: string; key: string; qty: number }) => emit.changed(payload) } })).build();
const compositeBuilder = createAggregate('composite-root', { entries: [{ region: 'r', key: 'k', qty: 0 }] })
  .entityList('entries', Composite, { pk: ['region', 'key'] as const }).events({}).commands(() => ({}))
  .selectors(({ bindContext }) => ({ selected: state => bindContext(state.entries, Composite, { mount: 'entries' }) })).build();
const composite = createMirage(compositeBuilder, 'one');
composite.entries({ region: 'r', key: 'k' }).setQty(2);
composite.selected()[0]!.setQty(3);
// @ts-expect-error Bound composite keys are injected; callers supply only the remaining command arguments.
composite.selected()[0]!.setQty('r', 'k', 3);
// @ts-expect-error Both primary-key fields are required.
composite.entries({ region: 'r' });
const MapEntry = createEntity<{ qty: number }, 'entry'>('entry').events({})
  .commands(() => ({ touch: { pack: (key: string) => ({ key }), handler: () => [] } })).build();
const mapBuilder = createAggregate('map', { entries: { one: { qty: 0 } } })
  .entityMap('entries', MapEntry, { knownKeys: ['one'] as const }).events({}).commands(() => ({})).build();
const map = createMirage(mapBuilder, 'map-one');
map.entries.one.touch();
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
