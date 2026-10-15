import { createAggregate, createAggregatePluginFor } from '@redemeine/aggregate';
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
