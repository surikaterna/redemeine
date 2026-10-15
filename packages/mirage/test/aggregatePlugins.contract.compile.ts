import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, createDepot, type EventStore } from '@redemeine/mirage';

const Counter = createAggregate('counter', { count: 0 })
  .events({ added(state, event: Event<number>) { state.count += event.payload; } })
  .commands(emit => ({ add: (_state, amount: number) => emit.added(amount) })).build();
const audit = createAggregatePluginFor(Counter, 'audit').state(() => ({ totals: [0] }))
  .events({ added(draft, event) { draft.totals.push(event.payload); } }).build();
const Decorated = Counter.withPlugins(audit);
const live = createMirage(Decorated, 'one');
const total: number | undefined = live.audit.totals[0];
live.add(2);
// @ts-expect-error decorated commands retain their input types
live.add('two');
// @ts-expect-error plugin-owned state is deeply readonly on Mirage
live.audit.totals.push(3);
// @ts-expect-error event descriptors are not lifecycle setup plugins
createMirage(Counter, 'bad', { plugins: [audit] });
declare const store: EventStore;
const depot = createDepot(Decorated, store);
async function consume() {
  const loaded = await depot.get('one');
  const values: readonly number[] = loaded.audit.totals;
  loaded.add(3);
  // @ts-expect-error Depot preserves readonly state
  loaded.audit.totals = [];
  return values;
}
// @ts-expect-error Depot options also require lifecycle plugins
createDepot(Counter, store, { plugins: [audit] });
void total;
void consume;

function datedAudit(clock: () => Date) {
  return createAggregatePlugin('datedAudit').state(() => ({ dates: [] as string[] }))
    .commandEnvelope(() => ({ dateTime: clock() }))
    .eventEnvelope((_, context) => ({ commandDate: new Date(context.command.dateTime.getTime()) }))
    .onEvent((draft, event) => { if ('commandDate' in event && event.commandDate instanceof Date) draft.dates.push(event.commandDate.toISOString()); }).build();
}
const Dated = Counter.withPlugins(datedAudit(() => new Date()));
const raw = Dated.commandCreators.add(1);
// @ts-expect-error raw command creators do not promise prepared extensions
raw.dateTime;
const prepared = Dated.prepareCommand(Dated.initialState, raw);
const date: Date = prepared.dateTime;
const payload: number = prepared.payload;
const dated = createMirage(Dated, 'dated');
const returned = dated.add(1);
// @ts-expect-error Mirage returns state, not the prepared command envelope
returned.dateTime;
// @ts-expect-error prepared dates are not public Mirage state
dated.dateTime;
// @ts-expect-error plugin state remains deeply readonly
dated.datedAudit.dates.push('mutation');
void date;
void payload;
